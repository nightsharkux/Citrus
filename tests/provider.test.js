'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {makeProviders}=require('../src/ai/providers');
test('Ollama uses local /api/chat without cloud Authorization header',async()=>{
 let request;
 const providers=makeProviders({env:{CAMPUS_OLLAMA_URL:'http://127.0.0.1:11434',CAMPUS_OLLAMA_MODEL:'llama3.2'},fetchImpl:async(url,opts)=>{
  request={url,opts};return {ok:true,json:async()=>({message:{role:'assistant',content:'Hello local'}})};
 }});
 assert.equal(providers.status('ollama').aiEnabled,true);
 const response=await providers.generate('ollama','You are a helpful teacher','Hello',[{role:'assistant',content:'Earlier'}]);
 assert.equal(response,'Hello local');assert.equal(request.url,'http://127.0.0.1:11434/api/chat');
 assert.equal(request.opts.headers.Authorization,undefined);
 const body=JSON.parse(request.opts.body);assert.equal(body.stream,false);assert.equal(body.messages[2].content,'Hello');
 assert.equal(providers.transcriptionReady(),false);
});
test('Cloud request uses server-side key; no fallback on cloud or local failure',async()=>{
 let request;
 const providers=makeProviders({env:{OPENAI_API_KEY:'secret-testing-key',CAMPUS_AI_MODEL:'gpt-4.1-mini'},fetchImpl:async(url,opts)=>{
  request={url,opts};return {ok:true,json:async()=>({choices:[{message:{content:'Cloud reply'}}]})};
 }});
 assert.equal(providers.status('openai').aiEnabled,true);
 assert.equal(await providers.generate('openai','Instructor directions','Help me'),'Cloud reply');
 assert.equal(request.url,'https://api.openai.com/v1/chat/completions');
 assert.equal(request.opts.headers.Authorization,'Bearer secret-testing-key');
 assert.equal(providers.status('off').aiEnabled,false);
 await assert.rejects(providers.generate('off','test','test'),/not configured/);
});
test('Transcription is explicitly opted in, separate from selected chat provider',async()=>{
 const a=makeProviders({env:{OPENAI_API_KEY:'key'}});
 assert.equal(a.transcriptionReady(),false);
 const b=makeProviders({env:{OPENAI_API_KEY:'key',CAMPUS_TRANSCRIPTION_PROVIDER:'openai'}});
 assert.equal(b.transcriptionReady(),true);
});
