'use strict';
const event=(type,payload={})=>({type,payload,source:'server',time:Date.now()});
module.exports={event};
