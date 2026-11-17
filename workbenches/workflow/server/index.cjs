'use strict';
const { dispatch } = require('./application/actions.cjs');
const { normalize } = require('./domain/state.cjs');
const health = () => ({ status: 'healthy', issues: [] });
module.exports = { dispatch, normalize, health };
