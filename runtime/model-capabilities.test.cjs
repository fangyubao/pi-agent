'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const caps=require('./model-capabilities.cjs');
test('model capability metadata is explicit and unknown stays unknown',()=>{
  assert.equal(caps.normalizeModel('demo').contextWindow,null);
  assert.deepEqual(caps.normalizeModel({id:'demo',context_length:64000,max_output_tokens:4096}),{id:'demo',contextWindow:64000,maxOutputTokens:4096,source:'provider'});
  assert.equal(caps.selected({model:'demo',modelMetadata:{demo:{contextWindow:64000}}},'demo').contextWindow,64000);
  assert.equal(caps.selected({model:'demo',modelMetadata:{demo:{contextWindow:64000}},modelLimits:{demo:{contextWindow:32000}}},'demo').source,'manual');
});
