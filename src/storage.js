const { JsonStore: Store } = require('./storage/jsonStore');
const { createStore, PostgresStore, emptyData } = require('./storage/index');

module.exports = { Store, createStore, PostgresStore, emptyData };