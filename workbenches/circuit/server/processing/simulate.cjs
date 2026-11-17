'use strict';
function simulate({qubits,gates}){
  if(!Number.isInteger(qubits)||qubits<1||qubits>12)throw new Error('本地状态向量模拟支持 1–12 个量子比特');
  const size=2**qubits,amplitudes=new Float64Array(size);amplitudes[0]=1;
  const sorted=gates.slice().sort((a,b)=>a.col-b.col);
  let measured=false;
  for(const g of sorted){
    if(g.gate==='M'){measured=true;continue;}
    if(measured)throw new Error('当前模拟只支持末尾测量；请把 M 门放在全部计算门之后');
    const bit=1<<(qubits-1-g.q);
    if(g.gate==='H'){
      for(let i=0;i<size;i++)if(!(i&bit)){const a=amplitudes[i],b=amplitudes[i|bit];amplitudes[i]=(a+b)/Math.SQRT2;amplitudes[i|bit]=(a-b)/Math.SQRT2;}
    }else if(g.gate==='X'){
      for(let i=0;i<size;i++)if(!(i&bit)){const temp=amplitudes[i];amplitudes[i]=amplitudes[i|bit];amplitudes[i|bit]=temp;}
    }else if(g.gate==='CNOT'){
      if(!Number.isInteger(g.t)||g.t===g.q||g.t<0||g.t>=qubits)throw new Error('CNOT 目标比特无效');
      const target=1<<(qubits-1-g.t);
      for(let i=0;i<size;i++)if((i&bit)&&!(i&target)){const temp=amplitudes[i];amplitudes[i]=amplitudes[i|target];amplitudes[i|target]=temp;}
    }else throw new Error('不支持的量子门：'+g.gate);
  }
  return [...amplitudes].flatMap((a,i)=>a*a>1e-12?[{bits:i.toString(2).padStart(qubits,'0'),probability:a*a}]:[]);
}
module.exports={simulate};
