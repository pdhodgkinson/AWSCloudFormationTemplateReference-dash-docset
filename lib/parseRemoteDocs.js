const fs = require('fs-extra');
const rp = require('request-promise-native');
const cheerio = require('cheerio');
const bPromise = require('bluebird');
const path = require('path');
const debug = require('debug')('parseRemoteDocs');
const appRootPath = require('app-root-path');

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

const documentationIndexFiles = {
    [documentationTypes.Resource]: 'aws-template-resource-type-ref.html',
    [documentationTypes.Property]: 'aws-product-property-reference.html',
    [documentationTypes.Attribute]: 'aws-product-attribute-reference.html',
    [documentationTypes.Function]: 'intrinsic-function-reference.html',
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
            debug(`processing ${type} element ${++count} of ${numPages}`);
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

const welcomeFile = `${awsDocumentationURL}/Welcome.html`;
let getPageGroups = () => {
    return rp(welcomeFile)
        .then(cheerio.load)
        .then($ =>  {
            let accumulator = {};
            Object.keys(documentationTypes).forEach(type => {
                let links = $(`[href="${documentationIndexFiles[type]}"] + ul a.awstoc`)
                    .map((i, link) => {
                        let href = $(link).attr('href');
                        let name = $(link).text();
                        name = name.replace(/ +(?= )/g,''); //There are some excess white spaces and new lines
                        name = name.replace(/\n/g, '');
                        return {
                            href,
                            name
                        }
                    })
                    .get();
                accumulator[type] = links;
            })
            
            return  accumulator;
        });
};

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


