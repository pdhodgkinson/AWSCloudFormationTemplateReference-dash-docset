const Sequelize = require('sequelize');
const { ResourcesDir } = require('./paths');

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

const writeToDbAsType = type => items => {
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
};

module.exports = {
    writeToDbAsType
};