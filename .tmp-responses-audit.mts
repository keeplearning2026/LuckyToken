import { convertResponsesRequest, convertResponsesRequestAsync } from './src/protocols/openai-responses/request.js';
const image = (data: string) => ({type:'input_image',image_url:`data:image/png;base64,${data}`,detail:'auto'});
const policy = { privilegedMessages:'first',unknownInputItem:'error',orphanToolOutput:'error',unresolvedToolCall:'xrepair',futureReasoningEffort:'max'} as const;
const run = (label: string, request: unknown) => {
  try { const r=convertResponsesRequest(request,1); console.log(label,JSON.stringify({pi:r.invocation.pi,notices:r.client.notices})); }
  catch (e) { console.log(label, String(e)); }
};
run('tool-result-image',{model:'m',input:[{type:'function_call',name:'see',call_id:'c',arguments:'{}'},{type:'function_call_output',call_id:'c',output:[image('AAAA')]}]});
run('interleaved-user-content',{model:'m',input:[{role:'user',content:[{type:'input_text',text:'first'},image('AAAA'),{type:'input_text',text:'second'},image('BBBB')]}]});
run('explicit-custom-text-format',{model:'m',input:'x',tools:[{type:'custom',name:'patch',format:{type:'text'}}]});
const r=await convertResponsesRequestAsync({model:'m',input:[{role:'user',content:[image('AAAA'),{type:'input_image',file_id:'remote',detail:'auto'}]}]},1,policy,{resolveItemReference:async()=>[image('BBBB')]});
console.log('mixed-inline-and-resolved',JSON.stringify({pi:r.invocation.pi,notices:r.client.notices}));
