'use strict';
process.once('message',async({root,operation,args})=>{
  const index=require('./knowledge-index.cjs').createKnowledgeIndex(root);
  try{if(!['build','search','read'].includes(operation))throw new Error('未知知识库操作');const result=await index[operation](...args);process.send({ok:true,result});}
  catch(error){process.send({ok:false,error:error.message});}
});
