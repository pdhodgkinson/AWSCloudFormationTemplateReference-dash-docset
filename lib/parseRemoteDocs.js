const Sequelize = require('sequelize');
const fs = require('fs-extra');
const rp = require('request-promise-native');
const cheerio = require('cheerio');
const bPromise = require('bluebird');
const path = require('path');
const debug = require('debug')('parseRemoteDocs');
const appRootPath = require('app-root-path');

const fixBrokenLinks = require('./fixBrokenLinks');
const { BuildDir, ResourcesDir, DocumentsDir } = require('./paths');
const { awsDocumentationURL, awsReleaseDate} = appRootPath.require('package.json');


//TODO: remove this:
require('../scripts/clean');

const MAX_REQUEST_CONCURRENCY = 4;
const TableName = 'searchIndex';


//TODO: move this into importable file
const htmlWrapper = `<!DOCTYPE html>
<html>
<head>
    <link href="css/awsdocs.css" rel="stylesheet" type="text/css">
    <script type="text/javascript" src="js/jquery.min.js"></script>
    <script type="text/javascript" src="js/awsdocs.min.js"></script>
    <meta charset=\"utf-8\" />
</head>
<body>
    <div id="content" style="padding: 10px 30px;">
    </div>
</body>
</html>`;

const seq = new Sequelize('database', 'username', 'password', {
    dialect: 'sqlite',
    storage: `${ResourcesDir}/docSet.dsidx`
});

const SearchIndex = seq.define(TableName, {
    id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    name: {
        type: Sequelize.STRING
    },
    type: {
        type: Sequelize.STRING
    },
    path: {
        type: Sequelize.STRING
    }
}, {
    freezeTableName: true,
    timestamps: false
});

//TODO: break this into smaller functions that make sense
let loadDocsFromIndex = rootFile => {
    return rp(rootFile)
        .then(html => {
            const $ = cheerio.load(html)
            let resourceElems = $('.highlights ul li a');
            let count = 0;
            let numElems = resourceElems.length;
            return bPromise.map(resourceElems.get(), elem => {
                debug(`processing ${rootFile} element ${++count} of ${numElems}`);
                let $elem = $(elem);
                let href = $elem.attr('href');
                let name = $elem.text()
                name = name.replace(/ +(?= )/g,''); //There are some excess white spaces and new lines
                name = name.replace(/\n/g, '');
                let path = `${awsDocumentationURL}/${href}`;
                return Promise.all([rp(path), href, name]);
            }, {concurrency: MAX_REQUEST_CONCURRENCY})
                .then(results => {
                    let resourceItems = bPromise.map(results, result => {
                        let [html, href, name] = result;
                        let $subDoc = cheerio.load(html);
                        let $newDoc = cheerio.load(htmlWrapper);
                        let mainBody = $subDoc('#language-filter').nextAll();
                        $newDoc('#content').append(mainBody);
                        
                        let path = href;
                        let fullPath = `${DocumentsDir}/${path}`;
                        let newHTML = $newDoc.html();
                        
                        return fs.outputFile(fullPath, newHTML)
                            .then(() => {
                                return {
                                    path,
                                    name
                                }
                            });
                    });
                    
                    return resourceItems;
                });
        });
}



let writeToDbAsType = type => items => {
    let dbItems = items.map(item => {
        let {name, path} = item;
        return {
            name,
            path,
            type
        };
    });
    
    
    return SearchIndex.sync()
        .then(() => {
            SearchIndex.bulkCreate(dbItems)
            return dbItems;
        })
}

let processDocsAtIndex = (indexFile, type) => {
    return loadDocsFromIndex(indexFile)
        .then(writeToDbAsType(type));
};

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
    let $index = cheerio.load(htmlWrapper);
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
    [documentationTypes.Resource]: `${awsDocumentationURL}/aws-template-resource-type-ref.html`,
    [documentationTypes.Property]: `${awsDocumentationURL}/aws-product-property-reference.html`,
    [documentationTypes.Attribute]: `${awsDocumentationURL}/aws-product-attribute-reference.html`,
    [documentationTypes.Function]: `${awsDocumentationURL}/intrinsic-function-reference.html`,
};

let copyStaticFiles = () => {
    return fs.copy(appRootPath.resolve('static'), BuildDir);
}
return copyStaticFiles()
    .then(() => {
        return Promise.all(Object.keys(documentationIndexFiles).map(type => {
            return processDocsAtIndex(documentationIndexFiles[type], type)
        }));
    })
    .then(flatten)
    .then(createIndex)
    .then(items => items.map(item => item.path))
    .then(postProcessFiles)
    .catch(err => {
        console.error(err);
    });


