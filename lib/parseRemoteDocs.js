const Sequelize = require('sequelize');
const fs = require('fs-extra');
const rp = require('request-promise-native');
const cheerio = require('cheerio');
const bPromise = require('bluebird');
const path = require('path');
const debug = require('debug')('parseRemoteDocs');
const appRootPath = require('app-root-path');

const fixBrokenLinks = require('./fixBrokenLinks');
const template = require('./template.html');
const { BuildDir, ResourcesDir, DocumentsDir } = require('./paths');
const { awsDocumentationURL, awsReleaseDate} = appRootPath.require('package.json');

const MAX_REQUEST_CONCURRENCY = 4;
const TableName = 'searchIndex';


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

let processPages = (type, pages) => {
    let count = 0;
    let numPages = pages.length;
    return bPromise.map(pages, ({href, name}) => { //TODO: function should be fetch pages
            debug(`processing ${type} element ${++count} of ${numPages}`);
            return Promise.all([rp(`${awsDocumentationURL}/${href}`), href, name]);
        }, {concurrency: MAX_REQUEST_CONCURRENCY})
        .then(results => {
            let resourceItems = bPromise.map(results, result => { //TODO: function should be parse page
                let html = result[0];
                let href = result[1];
                let name = result[2];
                let $subDoc = cheerio.load(html);
                let $newDoc = cheerio.load(template);
                let mainBody = $subDoc('#language-filter').nextAll();
                $newDoc('#content').append(mainBody);
        
                let fullPath = path.join(DocumentsDir, href);
                let newHTML = $newDoc.html();
        
                return fs.outputFile(fullPath, newHTML) //TODO: function should be write document
                    .then(() => {
                        return {
                            path: href,
                            name
                        }
                    });
            });
    
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


