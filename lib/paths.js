const path = require('path');
const appRootPath = require('app-root-path');
const {name} = appRootPath.require('package.json');

const BuildDir = appRootPath.resolve(name);
const ContentsDir = path.join(BuildDir, 'Contents');
const ResourcesDir = path.join(ContentsDir, 'Resources');
const DocumentsDir = path.join(ResourcesDir, 'Documents');

module.exports = {
    BuildDir,
    ContentsDir,
    ResourcesDir,
    DocumentsDir
};

