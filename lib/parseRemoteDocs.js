const fs = require('fs-extra');
const rp = require('request-promise-native');
const cheerio = require('cheerio');
const bPromise = require('bluebird');
const path = require('path');
const os = require('os');
const debug = require('debug')('parseRemoteDocs');
const appRootPath = require('app-root-path');
const jq = require('node-jq');
const uuid = require('uuid');

const fixBrokenLinks = require('./fixBrokenLinks');
const template = require('./template.html');
const { BuildDir, DocumentsDir } = require('./paths');
const { writeToDbAsType } = require('./db');
const { awsDocumentationURL, awsReleaseDate} = appRootPath.require('package.json');

const MAX_REQUEST_CONCURRENCY = 4;

const documentationTypes = {
    Resource: 'Resource',
    Property: 'Property',
    Attribute: 'Attribute',
    Function: 'Function'
};

const documentationIndexTitles = {
    [documentationTypes.Resource]: 'AWS Resource Types',
    [documentationTypes.Property]: 'Resource Property Types',
    [documentationTypes.Attribute]: 'Resource Attributes',
    [documentationTypes.Function]: 'Intrinsic Functions',
};

const documentationIndexJqQueryStringResourceAndPropertyGroup = '[.contents[] | select(.title=="Template Reference") | .contents[] | select(.title=="Resource and Property Reference") | .contents[]]'
const documentationIndexJqQueryStrings = {
    [documentationTypes.Resource]: '[.[] | .contents[] | {"name": .title, "href": .href}]',
    [documentationTypes.Property]: '[.[] | .title as $parent | select(.contents[].contents) | .contents[] | select(.contents) | .contents[] | {"name": "\\($parent) \\(.title)", "href": .href}] | unique',
    [documentationTypes.Attribute]: '[.contents[] | select(.title=="Template Reference") | .contents[] | select(.title=="Resource Attributes") | .contents[] | {"name": .title, "href": .href}]',
    [documentationTypes.Function]: '[.contents[] | select(.title=="Template Reference") | .contents[] | select(.title=="Intrinsic Functions") | .contents[] | {"name": .title, "href": .href}]',
};


const writePageToFileSystem = (html, rootDir, fileName) => {
    let fullPath = path.join(DocumentsDir, fileName);
    return fs.outputFile(fullPath, html)
};

const createNewPage = (html) => {
    let $subDoc = cheerio.load(html);
    let $newDoc = cheerio.load(template);
    let mainBody = $subDoc('#language-filter').nextAll();
    $newDoc('#content').append(mainBody);
    return $newDoc.html();
};

let processPage = (page)  => {
    let html = page[0];
    let href = page[1];
    let name = page[2];
    let newHtml = createNewPage(html);
    
    return writePageToFileSystem(newHtml, DocumentsDir, href)
        .then(() => {
            return {
                path: href,
                name
            }
        });
};

let processPages = (type, pages) => {
    let count = 0;
    let numPages = pages.length;
    return bPromise.map(pages, ({href, name}) => {
            debug(`processing ${type} element (${name}) ${++count} of ${numPages}`);
            return Promise.all([rp(`${awsDocumentationURL}/${href}`), href, name]);
        }, {concurrency: MAX_REQUEST_CONCURRENCY})
        .then(results => {
            let resourceItems = bPromise.map(results, processPage);
            return resourceItems;
        })
        .then(writeToDbAsType(type));
    
}

let processPageGroups = (pageGroups) => {
    return Promise.all(Object.keys(pageGroups).map(type => processPages(type, pageGroups[type])));
}

let flatten = itemGroups => {
    let items = itemGroups
        .reduce((accumulator, itemGroup) => {
            return accumulator.concat(itemGroup);
        }, []);
    
    return items;
}

let postProcessFiles = paths => {
    fixBrokenLinks(awsDocumentationURL, DocumentsDir, paths);
}


let createIndex = items => {
    let $index = cheerio.load(template);
    $index('head').append(`<title>AWS CloudFormation Template Reference ${awsReleaseDate}</title>`);
    
    let itemsByType = items.reduce((accumulator, currentValue) => {
        let { type, name, path } = currentValue;
        if (typeof accumulator[type] === 'undefined') {
            accumulator[type] = [];
        }
        accumulator[type].push({name, path})
        return accumulator;
    }, {});
    
    Object.keys(itemsByType).forEach(type => {
        let $newDoc = cheerio.load(`<h1>${documentationIndexTitles[type]}</h1>`);
        let items = itemsByType[type];
        items.forEach(item => {
            $newDoc.root().append(`<li><a href=${item.path}>${item.name}</a></li>`);
        });
    
        $index('#content').append($newDoc.html());
    });
    
    return fs.outputFile(path.join(DocumentsDir, 'index.html'), $index.html())
        .then(() => items);
}


let copyStaticFiles = () => {
    return fs.copy(appRootPath.resolve('static'), BuildDir);
}

let saveToTmpFile = (content) => {
    let tmpFilePath = path.join(os.tmpdir(), uuid.v4() + '.json');
    const buffer = Buffer.from(content, 'utf8');
    fs.writeFileSync(tmpFilePath, buffer);
    return tmpFilePath;
}

const tocFile = `${awsDocumentationURL}/toc-contents.json`;
let getResourceAndPropertyReferencePageGroups = (tocJsonPath) => {
    return jq.run(documentationIndexJqQueryStringResourceAndPropertyGroup, tocJsonPath, {output: 'json'})
        .then(resource_property_references => {
            return bPromise.map(resource_property_references, ({title, href, contents, include_contents}) => {
                return rp(`${awsDocumentationURL}/${include_contents}`).then(jsonString => {
                    json = JSON.parse(jsonString);
                    return json['contents'][0]
                }).catch(error => {
                    // Does not have 'include_contents' and therefore the 'contents' are complete
                    return {
                        'title': title,
                        'href': href,
                        'contents': contents
                    }
                });
            }, { concurrency: MAX_REQUEST_CONCURRENCY });
        })
        .then(JSON.stringify)
        .then(saveToTmpFile)
        .then(resourceAndPropertyReferenceJsonPath => {
            return Promise.all([
                jq.run(documentationIndexJqQueryStrings[documentationTypes.Resource], resourceAndPropertyReferenceJsonPath, {output: 'json'}),
                jq.run(documentationIndexJqQueryStrings[documentationTypes.Property], resourceAndPropertyReferenceJsonPath, {output: 'json'})
            ])
        })
}

let getPageGroups = () => {
	return rp(tocFile)
        .then(saveToTmpFile)
		.then(tocJsonPath => {
			return Promise.all([
				getResourceAndPropertyReferencePageGroups(tocJsonPath),
				jq.run(documentationIndexJqQueryStrings[documentationTypes.Attribute], tocJsonPath, {output: 'json'}),
				jq.run(documentationIndexJqQueryStrings[documentationTypes.Function], tocJsonPath, {output: 'json'})
			]);
		})
		.then(results => {
			let accumulator = {};

			resourceAndPropertyReferenceGroups = results[0]
			accumulator[documentationTypes.Resource] = resourceAndPropertyReferenceGroups[0];
			accumulator[documentationTypes.Property] = resourceAndPropertyReferenceGroups[1];

			accumulator[documentationTypes.Attribute] = results[1];
			accumulator[documentationTypes.Function] = results[2];

			return accumulator;
		})
}

return copyStaticFiles()
    .then(getPageGroups)
    .then(processPageGroups)
    .then(flatten)
    .then(createIndex)
    .then(items => items.map(item => item.path))
    .then(postProcessFiles)
    .catch(err => {
        console.error(err);
    });


