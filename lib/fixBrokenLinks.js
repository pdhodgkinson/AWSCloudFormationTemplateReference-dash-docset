const fs = require('fs-extra');
const cheerio = require('cheerio');
const path = require('path');
const debug = require('debug')('fixBrokenLinks');

const fixBrokenLinksInFile = (documentDir, fileName, rootDocuments, docRoot) => {
    debug(`Fixing broken links in ${fileName}`);
    let file = path.join(documentDir, fileName)
    return fs.readFile(file, 'utf-8')
        .then(cheerio.load)
        .then($ => {
            let anchors = $('a');
            anchors.each((i, el) => { //TODO: simplify this into filter step then update step
                    let href = $(el).attr('href');
                    if (typeof href !== 'undefined') {
                        let splitHref = href.split('#')[0];
                        if (!splitHref.startsWith('http') && !rootDocuments.includes(splitHref)) {
                            $(el).attr('href', `${docRoot}/${href}`)
                        }
                    }
                });
    
            let newContent = $.html();
            return fs.writeFile(file, newContent);
            
        });
}

// const getDocumentsInDir = (dir) => {
//     return fs.readdir(dir)
//         .then(files => files.filter(file => file.endsWith('.html')))
// }

// return getDocumentsInDir(documentDir)
//     .then(fixBrokenLinksInFile(documentDir, testFile))

const fixBrokenLinks = (docRoot, documentsDir, paths) => {
    return Promise.all(paths.map(path => {
        fixBrokenLinksInFile(documentsDir, path, paths, docRoot)
    }));
}

module.exports = fixBrokenLinks