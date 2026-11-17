'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PiTextDiff=api;})(globalThis,()=>{
  function compare(before,after){
    const a=before.split('\n'),b=after.split('\n');let head=0,tail=0;
    while(head<a.length&&head<b.length&&a[head]===b[head])head++;
    while(tail<a.length-head&&tail<b.length-head&&a[a.length-1-tail]===b[b.length-1-tail])tail++;
    const x=a.slice(head,a.length-tail),y=b.slice(head,b.length-tail),ops=[];
    for(let i=0;i<head;i++)ops.push({type:'same',text:a[i]});
    const coarse=(x.length+1)*(y.length+1)>1000000;
    if(coarse){for(const text of x)ops.push({type:'remove',text});for(const text of y)ops.push({type:'add',text});}
    else{
      const table=Array.from({length:x.length+1},()=>new Uint32Array(y.length+1));
      for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--)table[i][j]=x[i]===y[j]?table[i+1][j+1]+1:Math.max(table[i+1][j],table[i][j+1]);
      let i=0,j=0;
      while(i<x.length||j<y.length){
        if(i<x.length&&j<y.length&&x[i]===y[j]){ops.push({type:'same',text:x[i]});i++;j++;}
        else if(i<x.length&&(j===y.length||table[i+1][j]>=table[i][j+1]))ops.push({type:'remove',text:x[i++]});
        else ops.push({type:'add',text:y[j++]});
      }
    }
    for(let i=a.length-tail;i<a.length;i++)ops.push({type:'same',text:a[i]});
    const rows=[];let oldNumber=0,newNumber=0,removed=[],added=[];
    function flush(){for(let i=0;i<Math.max(removed.length,added.length);i++)rows.push({before:removed[i],after:added[i],oldNumber:i<removed.length?++oldNumber:null,newNumber:i<added.length?++newNumber:null,changed:true});removed=[];added=[];}
    for(const op of ops){if(op.type==='same'){flush();rows.push({before:op.text,after:op.text,oldNumber:++oldNumber,newNumber:++newNumber,changed:false});}else if(op.type==='remove')removed.push(op.text);else added.push(op.text);}
    flush();return{rows,coarse};
  }
  return{compare};
});
