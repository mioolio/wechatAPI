// Weixin 4.2.0.7 x64: separately relocated native coroutine and text/image ABI.
// Static evidence: artifacts/research/compat-4.2/send-*.json.
// This binary starts unvalidated; prior-version sends are not evidence for this version.
'use strict';
const PREFIX={
 '47310':'48 89 d0 48 8b 91 18 03 00 00 48 85 d2 74 1a', '30fdb0':'55 41 57 41 56 56 57 53 48 81 ec c8 01 00 00',
 '2060':'56 48 83 ec 20 48 8b 71 08 48 85 f6 74 23 f0 ff 4e 08',
 '49e370':'56 57 48 83 ec 28 8b 05 84 85 85 0b 65 48 8b 14 25 58 00 00 00',
 '45d10':'48 8b 05 59 f0 ca 0b c3',
 '47220':'56 48 83 ec 40 48 89 ce','382b50':'48 89 d0 48 8b 51 30 48 85 d2 74 14',
 '473e60':'55 56 57 48 81 ec 90 00 00 00','103fce0':'55 41 57 41 56 41 54 56 57 53 48 81 ec f0 05 00 00',
 '88ad0':'41 57 41 56 56 57 53 48 83 ec 20','2010':'48 83 ec 28 48 8b 41 18 48 83 f8 10',
 '570db60':'55 41 57 41 56 41 55 41 54 56 57 53 48 81 ec 18 03 00 00',
 '2c7ddd0':'55 41 57 41 56 41 55 41 54 56 57 53 48 81 ec 78 05 00 00',
 'a4a970':'55 56 57 53 48 81 ec 58 01 00 00 48 8d ac 24 80 00 00 00',
 '7a60':'48 83 ec 28 48 8b 41 18 48 83 f8 08',
 '10dcd0':'55 48 83 ec 30 48 8d 6c 24 30 48 c7 45 f8 fe ff ff ff 48 8b 09',
};
const tasks=new Map();let nextTask=0;
const requests=new Map(),callbacks=new Map();
const imageResources=new Map();
const VERIFIED_DLL_SHA256='9beb1051449e768417d770915646815a5bd1899cc2779f758069820794358ee0';
let textValidationAllowed=false,textValidationUsed=false;
let binding=null,sendValidated=false,imageSendValidated=false,imageValidationAllowed=false,imageRuntimeBlocked=false,preparing=false;
const isIndividualId=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/.test(value)&&!value.startsWith('gh_')&&!/^u_[a-f0-9]{16}$/.test(value)&&!['filehelper','weixin','newsapp','fmessage','medianote','qqmail','qmessage','tmessage','floatbottle','shakeapp','facebookapp','feedsapp','voiceinputapp','notification_messages','brandsessionholder'].includes(value);
const isTargetId=value=>value==='filehelper'||isIndividualId(value);
function moduleVerified(){const m=Process.getModuleByName('Weixin.dll');if(Process.arch!=='x64'||!m.path.replaceAll('\\','/').includes('/4.2.0.7/Weixin.dll'))throw Error('E_VERSION');return m;}
function fn(r,ret,args){const m=moduleVerified(),p=m.base.add(r);if(!Process.findRangeByAddress(p)?.protection.includes('x'))throw Error('E_CODE_REGION');const expected=PREFIX[r.toString(16)]?.split(' ').filter(Boolean).map(x=>parseInt(x,16));if(!expected?.length)throw Error('E_PROLOGUE_MISSING:'+r.toString(16));const actual=new Uint8Array(p.readByteArray(expected.length));if(!expected.every((b,i)=>b===actual[i]))throw Error('E_PROLOGUE:'+r.toString(16));return new NativeFunction(p,ret,args,{abi:'win64',scheduling:'cooperative'});}
function pair(){const p=Memory.alloc(16);p.writePointer(ptr(0));p.add(8).writePointer(ptr(0));return p;}
function release(p){fn(0x2060,'void',['pointer'])(p);p.writePointer(ptr(0));p.add(8).writePointer(ptr(0));}
function text(p){const n=p.add(16).readU64().toNumber(),c=p.add(24).readU64().toNumber();if(!Number.isSafeInteger(n)||n>1024||c<n||c>65536)return null;return(c<16?p:p.readPointer()).readUtf8String(n);}
function accountIdentity(owner){
 const p=owner.readPointer(),range=Process.findRangeByAddress(p),m=moduleVerified();
 if(p.isNull()||owner.add(8).readPointer().isNull()||!range?.protection.includes('r')||p.add(0x88).compare(range.base.add(range.size))>0||!p.readPointer().equals(m.base.add(0x90c0c78)))throw Error('E_ACCOUNT_TYPE');
 const self=text(p.add(0x48));if(!isIndividualId(self))throw Error('E_ACCOUNT_ID');
 return {account:p.toString(),self};
}
function verifyBoundAccount(){
 if(!binding)throw Error('E_BINDING');const owner=pair();
 try{fn(0x47220,'pointer',['pointer'])(owner);const proof=accountIdentity(owner);if(proof.account!==binding.account||proof.self!==binding.self)throw Error('E_ACCOUNT_CHANGED');return proof;}finally{release(owner);}
}
function lookup(targetId,displayName){
 const account=pair(),after=pair(),registry=pair(),service=pair(),contact=pair(),username=Memory.alloc(32);
 fn(0x88ad0,'pointer',['pointer','pointer'])(username,Memory.allocUtf8String(targetId));
 let phase='account';
 try{
  fn(0x47220,'pointer',['pointer'])(account);
  if(account.readPointer().isNull())throw Error('E_ACCOUNT');
  const identity=accountIdentity(account);
  phase='registry';fn(0x382b50,'pointer',['pointer','pointer'])(account.readPointer(),registry);
  if(registry.readPointer().isNull())throw Error('E_REGISTRY');
  phase='service';fn(0x473e60,'pointer',['pointer','pointer'])(registry.readPointer(),service);
  if(service.readPointer().isNull())throw Error('E_SERVICE');
  phase='contact';fn(0x103fce0,'pointer',['pointer','pointer','pointer'])(service.readPointer(),contact,username);
  const value=contact.readPointer();if(value.isNull())throw Error('E_CONTACT_NOT_FOUND');
  const id=text(value.add(8)),remark=text(value.add(0x78))===displayName,nickname=text(value.add(0xd8))===displayName;
  fn(0x47220,'pointer',['pointer'])(after);const current=accountIdentity(after);
  if(current.account!==identity.account||current.self!==identity.self)throw Error('E_ACCOUNT_CHANGED');
  return {chatId:id,displayName,displayNameMatches:remark||nickname,remarkMatches:remark,nicknameMatches:nickname,...identity};
 }catch(error){throw Error(phase+': '+error);}
 finally{fn(0x2010,'void',['pointer'])(username);for(const p of [contact,service,registry,after,account])release(p);}
}
function queue(callback){
 const key=String(++nextTask),runner=pair(),job=pair(),function64=Memory.alloc(64),source=Memory.alloc(32);
 function64.writeByteArray(new Uint8Array(64));
 const record={objects:new Map(),callbacks:[],source,sourceText:Memory.allocUtf8String('WXcc native reverse research'),sourceFunction:Memory.allocUtf8String('authorized_contact_lookup'),ran:false};
 tasks.set(key,record);
 const vtable=Memory.alloc(5*8);record.vtable=vtable;
 const create=()=>{const p=Memory.alloc(16);p.writePointer(vtable);record.objects.set(p.toString(),p);return p;};
 const clone=new NativeCallback((_self,_destination)=>create(),'pointer',['pointer','pointer'],'win64');
 const invoke=new NativeCallback(()=>{if(record.ran||record.cancelled)return;record.ran=true;try{const value=callback(()=>record.cancelled===true);record.completed=true;record.complete(value);}catch(error){record.error=String(error);record.reject?.(error);}},'void',['pointer'],'win64');
 const type=new NativeCallback(()=>ptr(0),'pointer',['pointer'],'win64');
 const destroy=new NativeCallback((self,_heap)=>{setTimeout(()=>{record.objects.delete(self.toString());if(record.objects.size===0){if(!record.ran)record.reject?.(Error('E_TASK_REJECTED: native executor did not run callback'));tasks.delete(key);}},1000);},'void',['pointer','bool'],'win64');
 record.callbacks.push(clone,invoke,type,destroy);
 [clone,clone,invoke,type,destroy].forEach((p,i)=>vtable.add(i*8).writePointer(p));
 function64.add(0x38).writePointer(create());
 source.writePointer(record.sourceText);source.add(8).writePointer(record.sourceFunction);source.add(16).writeU32(1);source.add(24).writePointer(invoke);
 return new Promise((resolve,reject)=>{
  record.resolve=resolve;record.reject=reject;
  record.complete=value=>resolve(value);
  const failQueue=error=>{record.cancelled=true;record.error=String(error);const failure=Error(String(error));if(record.ran)failure.code='E_TASK_STARTED_UNKNOWN';reject(failure);};
  try{
   const mainContext=fn(0x45d10,'pointer',[])();if(mainContext.isNull())throw Error('E_MAIN_CONTEXT');
   fn(0x47310,'pointer',['pointer','pointer'])(mainContext,runner);if(runner.readPointer().isNull())throw Error('E_RUNNER');
   fn(0x30fdb0,'pointer',['pointer','pointer','pointer','pointer','uint32'])(runner.readPointer(),job,source,function64,1);
   if(!function64.add(0x38).readPointer().isNull())throw Error('E_FUNCTION_NOT_TRANSFERRED');
  }catch(error){failQueue(error);}
  finally{
   let cleanupError=null;for(const p of [job,runner]){try{release(p);}catch(error){cleanupError??=error;}}
   if(cleanupError)failQueue(cleanupError);
  }
 });
}
function currentTask() {const p=pair();fn(0x49e370,'pointer',['pointer'])(p);if(p.readPointer().isNull())throw Error('E_NATIVE_TASK_SCOPE');return p;}
function inspect() {
 moduleVerified();for(const key of Object.keys(PREFIX))fn(parseInt(key,16),'void',[]);
 return {pid:Process.id,generation:binding?.generation??null,version:'4.2.0.7',dllSha256:VERIFIED_DLL_SHA256,self:binding?.self??null,accountVerified:binding!==null,ready:binding!==null&&!imageRuntimeBlocked,sendValidated,imageSendValidated,imageValidationAllowed,imageProloguesVerified:true,imageEntryRva:'0x2c7ddd0',chatId:binding?.chatId??null,sessionId:binding?.sessionId??null,displayName:binding?.displayName??null,prologuesVerified:true,pendingTasks:tasks.size,pendingCallbacks:callbacks.size,entryRva:'0x570db60',dispatch:'Weixin native coroutine queue',foregroundRequired:false,contactSnapshotAvailable:contactSnapshotValidated,lastContactPhase};
}
async function prepare(config) {
 if(binding||preparing)throw Error('E_ALREADY_BOUND');
 if(!config||config.pid!==Process.id||!isTargetId(config.chatId)||!isIndividualId(config.self)||config.sessionId!==config.chatId||typeof config.displayName!=='string'||!config.displayName.trim()||config.displayName.length>4096||/[\0\r\n]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(config.displayName)||config.chatId===config.displayName||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(config.generation??''))throw Error('E_BINDING_SCOPE');
 preparing=true;try{
 const proof=await queue(()=>{const task=currentTask();try{return {...lookup(config.chatId,config.displayName),taskState:task.readPointer().add(0x388).readU32(),nativeThreadId:Process.getCurrentThreadId()};}finally{release(task);}});
 if(proof.self!==config.self||proof.chatId!==config.chatId||!proof.displayNameMatches)throw Error('E_TARGET_IDENTITY');
 binding={pid:Process.id,generation:config.generation,self:config.self,chatId:config.chatId,sessionId:config.chatId,displayName:config.displayName,account:proof.account};
 // The host may reuse a recorded real send validation for this exact binary. Target/account proof is fresh for every prepare.
 sendValidated=config.validatedBinarySha256===VERIFIED_DLL_SHA256;
 textValidationAllowed=config.allowTextValidation===true&&config.chatId==='filehelper'&&!sendValidated;
 imageSendValidated=config.validatedImageBinarySha256===VERIFIED_DLL_SHA256;
 imageValidationAllowed=config.allowImageValidation===true&&config.chatId==='filehelper';
 return {...inspect(),identityProof:{username:proof.chatId,nicknameMatches:proof.nicknameMatches,remarkMatches:proof.remarkMatches,taskState:proof.taskState,nativeThreadId:proof.nativeThreadId}};
 }finally{preparing=false;}
}
function validateRequest(input,kind='text',validation=false) {
 if(!binding||input?.to!==binding.chatId)throw Error('E_CHAT_SCOPE');
 if(imageRuntimeBlocked||tasks.size>0||callbacks.size>0)throw Error('E_NATIVE_SEND_BUSY');
 if(!sendValidated&&!(validation===true&&textValidationAllowed&&binding.chatId==='filehelper'))throw Error('E_SEND_BINARY_UNVERIFIED');
 if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(input.requestId)||input.requestId!==input.requestId.toLowerCase())throw Error('E_REQUEST_ID');
 if(kind==='image'){
  if(!imageSendValidated&&!(imageValidationAllowed&&binding.chatId==='filehelper'))throw Error('E_IMAGE_BINARY_UNVERIFIED');
  if(typeof input.imageResource!=='string'||!/^wxcc-image-[a-f0-9-]{36}$/.test(input.imageResource)||!/^[a-f0-9]{64}$/.test(input.imageSha256??''))throw Error('E_IMAGE_PATH');
  const resource=imageResources.get(input.imageResource);if(!resource||resource.sha256!==input.imageSha256||resource.used)throw Error('E_IMAGE_RESOURCE');
 }else{
  const content=input.text;
  if(typeof content!=='string'||!content.trim()||content.includes('\0')||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(content)||unescape(encodeURIComponent(content)).length>1024)throw Error('E_TEXT');
 }
 if(requests.has(input.requestId))throw Error('E_REQUEST_DUPLICATE');
 if(requests.size>=10000)throw Error('E_REQUEST_LIMIT');
}
function nativeSend(input,entry,isCancelled) {
 if(isCancelled())throw Error('E_TASK_CANCELLED');
 const strings=Memory.alloc(72),correlation=Memory.alloc(32),handle=Memory.alloc(8),object=Memory.alloc(24);
 strings.writeByteArray(new Uint8Array(72));strings.add(64).writeU8(1);
 const keep={strings,correlation,handle,object,code:[],constructed:0};callbacks.set(input.requestId,keep);
 const result=new Promise(resolve=>{keep.resolve=resolve;});
 function finish(status,resultMessage) {if(entry.status!=='executing'&&entry.status!=='unknown')return;clearTimeout(keep.timer);entry.status=status;entry.completedAt=new Date().toISOString();entry.receipt={requestId:input.requestId,status,chatId:binding.chatId,sessionId:binding.sessionId,native:true,deliveryConfirmed:false,...(resultMessage?{resultMessage}:{})};if(status==='accepted')sendValidated=true;keep.resolve(entry.receipt);}
 const invoke=new NativeCallback((_self,value)=>{
  try{const success=value.readU8()!==0;const hasMessage=value.add(0x28).readU8()!==0;finish(success?'accepted':'failed',hasMessage?text(value.add(8)):undefined);}catch(error){entry.error=String(error);finish('unknown');}
 },'void',['pointer','pointer'],'win64');
 const destroy=new NativeCallback(()=>{keep.destroyed=true;setTimeout(()=>callbacks.delete(input.requestId),1000);},'void',['pointer'],'win64');
 keep.code.push(invoke,destroy);object.writeByteArray(new Uint8Array(24));object.writeS32(1);object.add(8).writePointer(invoke);object.add(16).writePointer(destroy);handle.writePointer(object);
 const ctor=fn(0x88ad0,'pointer',['pointer','pointer']),dtor=fn(0x2010,'void',['pointer']);
 try{
  const sendFunction=fn(0x570db60,'void',['pointer','pointer','pointer','pointer']);
  ctor(strings,Memory.allocUtf8String(input.to));keep.constructed=1;
  ctor(strings.add(32),Memory.allocUtf8String(input.text));keep.constructed=2;
  ctor(correlation,Memory.allocUtf8String(input.requestId));keep.constructed=3;
  if(text(strings)!==input.to||text(strings.add(32))!==input.text)throw Error('E_STRING_ROUNDTRIP');
  // Native constructors release the JS lock. Recheck cancellation after all native preparation, immediately before entry.
  if(isCancelled())throw Error('E_TASK_CANCELLED');
  verifyBoundAccount();
  entry.nativeEntryCalled=true;
  keep.timer=setTimeout(()=>finish('unknown'),12000);
  sendFunction(ptr(0),strings,correlation,handle);
 }catch(error){entry.error=String(error);finish(entry.nativeEntryCalled?'unknown':'failed');}
 finally{
  if(keep.constructed>=3)dtor(correlation);if(keep.constructed>=2)dtor(strings.add(32));if(keep.constructed>=1)dtor(strings);
  // The native entry consumes this owner: it moves the handle on success, and releases it on error.
  // Once entered (including an exception of unknown outcome), never release its callback a second time.
  if(!entry.nativeEntryCalled&&!handle.readPointer().isNull()){fn(0x10dcd0,'void',['pointer'])(handle);handle.writePointer(ptr(0));}
 }
 return result;
}
async function sendText(input) {return await sendTextOperation(input);}
async function sendTextOperation(input,validation=false) {
 validateRequest(input,'text',validation);
 const entry={status:'executing',createdAt:new Date().toISOString(),nativeEntryCalled:false};requests.set(input.requestId,entry);
 try{
  const pending=await queue(isCancelled=>{
   const task=currentTask();
   try{const proof=lookup(binding.chatId,binding.displayName);if(isCancelled())throw Error('E_TASK_CANCELLED');if(proof.self!==binding.self||proof.chatId!==binding.chatId||!proof.displayNameMatches||proof.account!==binding.account)throw Error('E_ACCOUNT_OR_TARGET_CHANGED');return {promise:nativeSend(input,entry,isCancelled)};}finally{release(task);}
  });
  return await pending.promise;
 }catch(error){entry.error=String(error);entry.status=entry.nativeEntryCalled||error.code==='E_TASK_STARTED_UNKNOWN'?'unknown':'failed';return {requestId:input.requestId,status:entry.status,chatId:binding.chatId,sessionId:binding.sessionId,native:true,error:entry.error};}
}
// Engineering-only one-shot native API validation for File Transfer Assistant.
// Enabling this flag is confined to filehelper and does not mark the binary validated.
async function validateText(input){
 if(!binding||binding.chatId!=='filehelper'||!textValidationAllowed||textValidationUsed||sendValidated)throw Error('E_TEXT_VALIDATION_SCOPE');
 if(!input||Object.keys(input).some(key=>key!=='requestId')||!/^wxcc42-text-validation-[a-f0-9]{32}$/.test(input.requestId??''))throw Error('E_TEXT_VALIDATION_REQUEST');
 textValidationUsed=true;
 return await sendTextOperation({to:'filehelper',text:'WXcc 4.2.0.7 兼容性验证',requestId:input.requestId},true);
}
// The native business entry accepts a resource key and resolves it into the app's
// HttpResource cache. It does not accept an ordinary local file path.
async function prepareImage(input){
 if(!binding||input?.to!==binding.chatId)throw Error('E_CHAT_SCOPE');
 if(imageRuntimeBlocked||tasks.size>0||callbacks.size>0)throw Error('E_NATIVE_SEND_BUSY');
 if(!sendValidated||(!imageSendValidated&&!(imageValidationAllowed&&binding.chatId==='filehelper')))throw Error('E_IMAGE_BINARY_UNVERIFIED');
 if(!/^wxcc-image-[a-f0-9-]{36}$/.test(input.imageResource??'')||!/^[a-f0-9]{64}$/.test(input.imageSha256??'')||imageResources.has(input.imageResource)||imageResources.size>=1000)throw Error('E_IMAGE_RESOURCE');
 return await queue(isCancelled=>{
  const task=currentTask(),resource=Memory.alloc(32),empty=Memory.alloc(32),result=Memory.alloc(32);let constructed=0,returned=false;
  try{
   const proof=lookup(binding.chatId,binding.displayName);if(isCancelled())throw Error('E_TASK_CANCELLED');if(proof.self!==binding.self||proof.chatId!==binding.chatId||!proof.displayNameMatches||proof.account!==binding.account)throw Error('E_ACCOUNT_OR_TARGET_CHANGED');
   const ctor=fn(0x88ad0,'pointer',['pointer','pointer']);ctor(resource,Memory.allocUtf8String(input.imageResource));constructed=1;ctor(empty,Memory.allocUtf8String(''));constructed=2;
   if(isCancelled())throw Error('E_TASK_CANCELLED');verifyBoundAccount();
   fn(0xa4a970,'pointer',['pointer','pointer','pointer'])(result,resource,empty);returned=true;
   const length=result.add(16).readU64().toNumber(),capacity=result.add(24).readU64().toNumber();
   if(!Number.isSafeInteger(length)||length<1||length>32767||!Number.isSafeInteger(capacity)||capacity<length||capacity>65536)throw Error('E_IMAGE_CACHE_PATH');
   const cachePath=(capacity<8?result:result.readPointer()).readUtf16String(length);
   if(typeof cachePath!=='string'||cachePath.includes('\0')||!/^[A-Za-z]:[\\/].*[\\/]HttpResource[\\/][a-f0-9]{32,64}$/i.test(cachePath)||cachePath.split(/[\\/]/).includes('..'))throw Error('E_IMAGE_CACHE_PATH');
   verifyBoundAccount();imageResources.set(input.imageResource,{sha256:input.imageSha256,used:false});
   return {pid:Process.id,generation:binding.generation,self:binding.self,chatId:binding.chatId,imageResource:input.imageResource,imageSha256:input.imageSha256,cachePath,automaticMessagesSent:0};
  }finally{
   let cleanupError=null;
   for(const [needed,rva,p] of [[returned,0x7a60,result],[constructed>=2,0x2010,empty],[constructed>=1,0x2010,resource]]){if(needed)try{fn(rva,'void',['pointer'])(p);}catch(error){cleanupError??=error;}}
   try{release(task);}catch(error){cleanupError??=error;}if(cleanupError){imageRuntimeBlocked=true;throw cleanupError;}
  }
 });
}
// Static call chain: native dispatcher 0x5702810 -> image business 0x2c7ddd0 ->
// native image factory 0x1da5fc0 -> MessageManager 0x17c76e0. The entry owns no
// incoming pointers. Its 0x40-byte result owns only the std::string at +0x20; +0x10 is new metadata.
// Initial send-stage acceptance does not establish server delivery.
function nativeSendImage(input,entry,isCancelled){
 const recipient=Memory.alloc(32),path=Memory.alloc(32),result=Memory.alloc(0x40);
 result.writeByteArray(new Uint8Array(0x40));
 const keep={recipient,path,result,constructed:0};entry.keep=keep;
 const ctor=fn(0x88ad0,'pointer',['pointer','pointer']),dtor=fn(0x2010,'void',['pointer']);
 let resultReturned=false,receipt;
 try{
  const imageSend=fn(0x2c7ddd0,'pointer',['pointer','pointer','pointer','pointer']);
  ctor(recipient,Memory.allocUtf8String(input.to));keep.constructed=1;
  ctor(path,Memory.allocUtf8String(input.imageResource));keep.constructed=2;
  if(text(recipient)!==input.to||text(path)!==input.imageResource)throw Error('E_STRING_ROUNDTRIP');
  if(isCancelled())throw Error('E_TASK_CANCELLED');
  verifyBoundAccount();
  entry.nativeEntryCalled=true;
  imageSend(ptr(0),result,recipient,path);resultReturned=true;
  const accepted=result.readU8()===1;
  const resultMessage=text(result.add(0x20));
  receipt={requestId:input.requestId,status:accepted?'accepted':'failed',type:'image',chatId:binding.chatId,sessionId:binding.sessionId,native:true,nativeEntryCalled:true,entryRva:'0x2c7ddd0',deliveryConfirmed:false,...(accepted?{localId:result.add(8).readU64().toString(),createTime:result.add(0x18).readU64().toString(),extraNativeId:result.add(0x10).readU64().toString()}:{}),...(resultMessage?{resultMessage}:{})};
  if(accepted)imageSendValidated=true;
 }catch(error){
  entry.error=String(error);if(entry.nativeEntryCalled)imageRuntimeBlocked=true;
  receipt={requestId:input.requestId,status:entry.nativeEntryCalled?'unknown':'failed',type:'image',chatId:binding.chatId,sessionId:binding.sessionId,native:true,nativeEntryCalled:entry.nativeEntryCalled,deliveryConfirmed:false,error:entry.error};
 }finally{
  // Only a normal returned result has an established live string object.
  for(const [needed,p] of [[resultReturned,result.add(0x20)],[keep.constructed>=2,path],[keep.constructed>=1,recipient]]){if(needed)try{dtor(p);}catch(error){imageRuntimeBlocked=true;entry.error=String(error);receipt={...receipt,status:entry.nativeEntryCalled?'unknown':'failed',error:entry.error};}}
  if(!imageRuntimeBlocked)delete entry.keep;
 }
 entry.status=receipt.status;entry.completedAt=new Date().toISOString();entry.receipt=receipt;
 return receipt;
}
async function sendImage(input){
 validateRequest(input,'image');
 imageResources.get(input.imageResource).used=true;
 const entry={status:'executing',createdAt:new Date().toISOString(),nativeEntryCalled:false};requests.set(input.requestId,entry);
 try{return await queue(isCancelled=>{const task=currentTask();try{const proof=lookup(binding.chatId,binding.displayName);if(isCancelled())throw Error('E_TASK_CANCELLED');if(proof.self!==binding.self||proof.chatId!==binding.chatId||!proof.displayNameMatches||proof.account!==binding.account)throw Error('E_ACCOUNT_OR_TARGET_CHANGED');return nativeSendImage(input,entry,isCancelled);}finally{release(task);}});}
 catch(error){entry.error=String(error);entry.status=entry.nativeEntryCalled||error.code==='E_TASK_STARTED_UNKNOWN'?'unknown':'failed';if(entry.status==='unknown')imageRuntimeBlocked=true;return {requestId:input.requestId,status:entry.status,type:'image',chatId:binding.chatId,sessionId:binding.sessionId,native:true,error:entry.error};}
}
rpc.exports={inspect,prepare,sendText,validateText,prepareImage,sendImage,contacts:contactsSnapshot,accountLayout,requestStatus(id){const result=requests.get(id);return result?{requestId:id,status:result.status,createdAt:result.createdAt,...(result.completedAt?{completedAt:result.completedAt}:{}),...(result.receipt?{receipt:result.receipt}:{})}:null;}};

// Embeddable fragment for agents/send-native.js; no RPC, hook, queue, or call runs on load.
// Static research against Weixin.dll 4.2.0.7, SHA-256:
// 9beb1051449e768417d770915646815a5bd1899cc2779f758069820794358ee0.
// Requires the existing PREFIX/fn/pair/release/currentTask/moduleVerified/binding helpers.
// Invoke only after prepare, inside `await queue(() => cachedContacts())`.
Object.assign(PREFIX, {
 '382bc0':'56 57 53 48 83 ec 40 48 89 d6 48 89 cf',
 '6fe980':'56 57 48 83 ec 38 48 89 d6 48 8d 05 08 48 9c 08',
 '7690f28':'33 d2 e9 41 00 00 00',
 '7690f50':'48 83 ec 28 83 69 4c 01 75 0e 83 49 48 ff 48 83',
 '7690f70':'48 89 5c 24 10 48 89 6c 24 18 48 89 74 24 20 57',
});

let lastContactPhase='idle',contactSnapshotValidated=false;
function cachedContacts() {
 lastContactPhase='binding';
 if (!binding || binding.pid !== Process.id) throw Error('E_CONTACTS_BINDING');
 const capturedBinding = binding, generation = binding.generation;
 const module = moduleVerified(), base = module.base;
 const storeGetter = fn(0x6fe980, 'pointer', ['pointer', 'pointer']);
 const lock = fn(0x7690f28, 'int', ['pointer']);
 const unlock = fn(0x7690f50, 'int', ['pointer']);
 // Prove the leaf jump destination before calling the mutex wrapper.
 fn(0x7690f70, 'int', ['pointer', 'pointer']);
 lastContactPhase='system-module';
 const kernel32 = Process.enumerateModules().find(m => m.name.toLowerCase() === 'kernel32.dll');
 if (!kernel32) throw Error('E_CONTACTS_SYSTEM_MODULE');
 const imports = [
  [0x9f87e78, 'AcquireSRWLockExclusive'], [0x9f88148, 'GetCurrentThreadId'],
  [0x9f88630, 'ReleaseSRWLockExclusive'], [0x9f887e0, 'TryAcquireSRWLockExclusive'],
 ];
 lastContactPhase='system-imports';
 for (const [rva, name] of imports) {
  const target = base.add(rva).readPointer(), expected = kernel32.getExportByName(name);
  if (!target.equals(expected) || !Process.findRangeByAddress(target)?.protection.includes('x'))
   throw Error('E_CONTACTS_MUTEX_IMPORT:' + name);
  const targetModule = Process.findModuleByAddress(target);
  if (!targetModule || !['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'].includes(targetModule.name.toLowerCase()))
   throw Error('E_CONTACTS_MUTEX_TARGET:' + name);
 }

 const maxNodes = 4096, maxNameBytes = 16384;
 const knownRanges = [];
 function readable(p, length) {
  if (p.isNull() || !Number.isSafeInteger(length) || length <= 0) throw Error('E_CONTACTS_POINTER');
  const end = p.add(length);
  let range = knownRanges.find(r => p.compare(r.base) >= 0 && end.compare(r.base.add(r.size)) <= 0);
  if (!range) {
   range = Process.findRangeByAddress(p);
   if (!range || !range.protection.includes('r') || end.compare(range.base.add(range.size)) > 0)
    throw Error('E_CONTACTS_READABLE');
   knownRanges.push(range);
  }
  return p;
 }
 function number64(p, max, code) {
  const value = p.readU64().toNumber();
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw Error(code);
  return value;
 }
 function string(p, max) {
  // Caller has checked the 32-byte header's containing contact or node allocation.
  const n = number64(p.add(16), max, 'E_CONTACTS_STRING_SIZE');
  const capacity = number64(p.add(24), 1048576, 'E_CONTACTS_STRING_CAPACITY');
  if (capacity < n || (capacity < 16 && capacity !== 15)) throw Error('E_CONTACTS_STRING_LAYOUT');
  const data = capacity < 16 ? p : p.readPointer();
  readable(data, n + 1);
  if (data.add(n).readU8() !== 0) throw Error('E_CONTACTS_STRING_TERMINATOR');
  const value = data.readUtf8String(n);
  if (typeof value !== 'string' || value.includes('\0'))
   throw Error('E_CONTACTS_STRING_ENCODING');
  return value;
 }
 const task = pair(), account = pair(), registry = pair(), storePair = pair(), afterAccount = pair();
 let mutex = null, locked = false, result = null;
 try {
  lastContactPhase='current-task';
  fn(0x49e370, 'pointer', ['pointer'])(task);
  if (task.readPointer().isNull()) throw Error('E_NATIVE_TASK_SCOPE');
  lastContactPhase='account';
  fn(0x47220, 'pointer', ['pointer'])(account);
  const accountPointer = account.readPointer();
  if (accountPointer.isNull() || accountPointer.toString() !== capturedBinding.account)
   throw Error('E_ACCOUNT_OR_TARGET_CHANGED');
  readable(accountPointer, 0x470);
  if (!accountPointer.readPointer().equals(base.add(0x90c0c78))) throw Error('E_CONTACTS_ACCOUNT_TYPE');
  if (accountIdentity(account).self !== capturedBinding.self) throw Error('E_ACCOUNT_OR_TARGET_CHANGED');
  const center = readable(accountPointer.add(0x460).readPointer(), 0xc8);
  const centerControl = readable(accountPointer.add(0x468).readPointer(), 0x10);
  if (!center.readPointer().equals(base.add(0x9264988)) || centerControl.add(8).readS32() <= 0)
   throw Error('E_CONTACTS_CACHE_CENTER_TYPE');
  lastContactPhase='registry';
  // This is account.vtable+0x38. The ordinary service container at +0x28 is a different type.
  // The center is already nonempty; the getter cannot enter its lazy factory branch here.
  fn(0x382bc0, 'pointer', ['pointer', 'pointer'])(accountPointer, registry);
  if (registry.readPointer().isNull()) throw Error('E_CONTACTS_REGISTRY');
  if (!registry.readPointer().equals(center) || !registry.readPointer().readPointer().equals(base.add(0x9264988))) throw Error('E_CONTACTS_CACHE_CENTER_TYPE');
  lastContactPhase='store';
  storeGetter(registry.readPointer(), storePair);
  const store = readable(storePair.readPointer(), 0x1f0);
  if (storePair.add(8).readPointer().isNull() || !store.readPointer().equals(base.add(0x926af08)))
   throw Error('E_CONTACTS_STORE_TYPE');
  mutex = store.add(0x1a0);
  if (mutex.readU32() !== 2 || mutex.add(0x4c).readU32() === 0x7fffffff)
   throw Error('E_CONTACTS_MUTEX_LAYOUT');
  lastContactPhase='lock';
  if (lock(mutex) !== 0) throw Error('E_CONTACTS_LOCK');
  locked = true;
  if (mutex.add(0x4c).readU32() === 0x7fffffff) throw Error('E_CONTACTS_MUTEX_OVERFLOW');
  lastContactPhase='snapshot';
  const deadline = Date.now() + 2500;
  const head = readable(store.add(0xd0).readPointer(), 0x40);
  const count = number64(store.add(0xd8), maxNodes, 'E_CONTACTS_CACHE_LIMIT');
  const bucketCount = number64(store.add(0x100), 65536, 'E_CONTACTS_BUCKET_LIMIT');
  const mask = number64(store.add(0xf8), 65535, 'E_CONTACTS_BUCKET_MASK');
  if (bucketCount < 8 || (bucketCount & (bucketCount - 1)) !== 0 || mask !== bucketCount - 1)
   throw Error('E_CONTACTS_MAP_LAYOUT');
  const buckets = readable(store.add(0xe0).readPointer(), bucketCount * 16);
  const bucketEnd = store.add(0xe8).readPointer(), bucketCapacityEnd = store.add(0xf0).readPointer();
  if (!bucketEnd.equals(buckets.add(bucketCount * 16)) || bucketCapacityEnd.compare(bucketEnd) < 0)
   throw Error('E_CONTACTS_BUCKET_VECTOR');
  const nodes = new Set(), ids = new Set(), rows = [];
  let node = head.readPointer(), previous = head;
  while (!node.equals(head)) {
   if (nodes.size >= count || nodes.size >= maxNodes || nodes.has(node.toString()))
    throw Error('E_CONTACTS_CHAIN_BOUND');
   if ((nodes.size & 31) === 0 && Date.now() > deadline) throw Error('E_CONTACTS_SNAPSHOT_TIMEOUT');
   readable(node, 0x40);
   const next = readable(node.readPointer(), 0x10);
   if (!node.add(8).readPointer().equals(previous) || !next.add(8).readPointer().equals(node))
    throw Error('E_CONTACTS_CHAIN_LINK');
   nodes.add(node.toString());
   const value = readable(node.add(0x30).readPointer(), 0xf8);
   const control = readable(node.add(0x38).readPointer(), 0x10);
   // Borrow node-owned contact references while holding the store mutex. No contact refcount is changed.
   if (control.add(8).readS32() <= 0 || control.add(12).readS32() <= 0)
    throw Error('E_CONTACTS_CONTROL');
   const username = string(node.add(0x10), 256);
   if (!/^[^\s\0]{1,256}$/u.test(username) || username !== string(value.add(8), 256) || ids.has(username))
    throw Error('E_CONTACTS_IDENTITY');
   ids.add(username);
   const type = value.add(4).readU32(), alias = string(value.add(0x28), maxNameBytes);
   const remark = string(value.add(0x78), maxNameBytes), nickname = string(value.add(0xd8), maxNameBytes);
   rows.push({username, type, nickname, remark, alias, displayName: remark || nickname || '（未命名）'});
   previous = node;
   node = next;
  }
  if (rows.length !== count || !head.add(8).readPointer().equals(previous)) throw Error('E_CONTACTS_CHAIN_COUNT');
  // Every bucket endpoint must refer to this exact list or its sentinel; do not follow another structure.
  nodes.add(head.toString());
  for (let i = 0; i < bucketCount * 2; ++i) {
   if ((i & 255) === 0 && Date.now() > deadline) throw Error('E_CONTACTS_SNAPSHOT_TIMEOUT');
   if (!nodes.has(buckets.add(i * 8).readPointer().toString())) throw Error('E_CONTACTS_BUCKET_ENDPOINT');
  }
  result = {scope: 'loaded-contact-cache', complete: false, cacheSnapshotComplete: true,
            count: rows.length, generation, contacts: rows};
 } finally {
  let cleanupError = null;
  if (locked) {
   try {if (unlock(mutex) !== 0) throw Error('E_CONTACTS_UNLOCK');} catch (error) {cleanupError = error;}
  }
  // Validate again after unlock while retaining the original account owner, avoiding a pointer reuse window.
  if (result !== null && cleanupError === null) {
   try {
    fn(0x47220, 'pointer', ['pointer'])(afterAccount);
    if (binding !== capturedBinding || binding.generation !== generation ||
        afterAccount.readPointer().toString() !== capturedBinding.account || accountIdentity(afterAccount).self !== capturedBinding.self) throw Error('E_ACCOUNT_OR_TARGET_CHANGED');
   } catch (error) {cleanupError = error;}
  }
  // Reverse acquisition order. Pairs stay alive until all borrowed fields have been copied and the lock released.
  for (const p of [afterAccount, storePair, registry, account, task]) {
   try {release(p);} catch (error) {cleanupError ??= error;}
  }
  if (cleanupError) throw cleanupError;
 }
 return result;
}

async function contactsSnapshot() { if(!binding) throw Error('E_CONTACTS_BINDING'); const result=await queue(() => cachedContacts()); contactSnapshotValidated=true; return {pid:Process.id,...result,automaticMessagesSent:0}; }

async function accountLayout(){if(!binding)throw Error('E_BINDING');return await queue(()=>{const task=currentTask(),account=pair();try{fn(0x47220,'pointer',['pointer'])(account);const p=account.readPointer();if(p.isNull()||p.toString()!==binding.account||accountIdentity(account).self!==binding.self)throw Error('E_ACCOUNT');const m=moduleVerified(),v=p.readPointer(),f=v.add(0x38).readPointer();if(v.compare(m.base)<0||v.compare(m.base.add(m.size))>=0||f.compare(m.base)<0||f.compare(m.base.add(m.size))>=0)throw Error('E_ACCOUNT_TYPE');return {accountVtableRva:v.sub(m.base).toString(),getterSlot38Rva:f.sub(m.base).toString(),nativeSendCalled:false};}finally{release(account);release(task);}});}
