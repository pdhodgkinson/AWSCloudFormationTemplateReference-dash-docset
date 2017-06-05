const fs = require('fs-extra');
const appRootPath = require('app-root-path');
const paths = appRootPath.require('./lib/paths');

fs.emptyDirSync(paths.BuildDir);