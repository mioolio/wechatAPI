// Weixin 4.1.15.13 x64 read-only native coroutine services. No send API.
"use strict";
const PREFIX={
 '47310':'48 89 d0 48 8b 91 18 03 00 00 48 85 d2 74 1a', '2fb010':'55 41 57 41 56 56 57 53 48 81 ec c8 01 00 00',
 '2060':'56 48 83 ec 20 48 8b 71 08 48 85 f6 74 23 f0 ff 4e 08',
 '48af50':'56 57 48 83 ec 28 8b 05 44 92 48 0b 65 48 8b 14 25 58 00 00 00',
 '45d10':'48 8b 05 79 c9 8c 0b c3',
 '47220':'56 48 83 ec 40 48 89 ce','36c740':'48 89 d0 48 8b 51 30 48 85 d2 74 14',
 '460a40':'55 56 57 48 81 ec 90 00 00 00','100a690':'55 41 57 41 56 41 54 56 57 53 48 81 ec f0 05 00 00',
 '88ad0':'41 57 41 56 56 57 53 48 83 ec 20','2010':'48 83 ec 28 48 8b 41 18 48 83 f8 10',
 '107050':'55 48 83 ec 30 48 8d 6c 24 30 48 c7 45 f8 fe ff ff ff 48 8b 09',
};

const tasks=new Map();let nextTask=0;let binding=null;
const VERIFIED_DLL_SHA256='10f8e995453e2da46d4f2b5080cd6da1f13cc5147746adc119ceae38cb039de5';
function moduleVerified(){const m=Process.getModuleByName('Weixin.dll');if(Process.arch!=='x64'||!m.path.replaceAll('\\','/').includes('/4.1.15.13/Weixin.dll'))throw Error('E_VERSION');return m;}
function fn(r,ret,args){const m=moduleVerified(),p=m.base.add(r);if(!Process.findRangeByAddress(p)?.protection.includes('x'))throw Error('E_CODE_REGION');const expected=PREFIX[r.toString(16)]?.split(' ').filter(Boolean).map(x=>parseInt(x,16));if(!expected?.length)throw Error('E_PROLOGUE_MISSING:'+r.toString(16));const actual=new Uint8Array(p.readByteArray(expected.length));if(!expected.every((b,i)=>b===actual[i]))throw Error('E_PROLOGUE:'+r.toString(16));const native=new NativeFunction(p,ret,args,{abi:'win64',scheduling:'cooperative'});return(...values)=>{try{return native(...values);}catch(error){runtimeBlocked=true;throw Error('E_NATIVE_CALL_UNKNOWN:'+r.toString(16));}};}
function pair(){const p=Memory.alloc(16);p.writePointer(ptr(0));p.add(8).writePointer(ptr(0));return p;}
function release(p){fn(0x2060,'void',['pointer'])(p);p.writePointer(ptr(0));p.add(8).writePointer(ptr(0));}
function readable(p,length,label='native'){
 if(p.isNull()||!Number.isSafeInteger(length)||length<=0||length>4*1024*1024)throw Error('E_READ_POINTER:'+label);
 const end=p.add(length);let cursor=p;
 for(let hops=0;cursor.compare(end)<0;hops++){
  const r=Process.findRangeByAddress(cursor);
  if(hops>=256||!r||!r.protection.includes('r'))throw Error('E_READ_RANGE:'+label);
  const next=r.base.add(r.size);if(next.compare(cursor)<=0)throw Error('E_READ_RANGE:'+label);
  cursor=next.compare(end)<0?next:end;
 }
 return p;
}
function text(p,max=16384,label='string'){readable(p,32,label+'-header');const n=p.add(16).readU64().toNumber(),c=p.add(24).readU64().toNumber();if(!Number.isSafeInteger(n)||n<0||n>max||!Number.isSafeInteger(c)||c<n||c>1048576||(c<16&&c!==15))throw Error('E_STRING_LAYOUT:'+label);const data=readable(c<16?p:p.readPointer(),n+1,label+'-data');if(data.add(n).readU8()!==0)throw Error('E_STRING_TERMINATOR:'+label);const value=data.readUtf8String(n);if(typeof value!=='string'||value.includes('\0'))throw Error('E_STRING_ENCODING:'+label);return value;}

function queue(callback){
 const key=String(++nextTask),runner=pair(),job=pair(),function64=Memory.alloc(64),source=Memory.alloc(32);
 function64.writeByteArray(new Uint8Array(64));
 const record={objects:new Map(),callbacks:[],source,sourceText:Memory.allocUtf8String('WXcc native read services'),sourceFunction:Memory.allocUtf8String('native_read_request'),ran:false};
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
   fn(0x2fb010,'pointer',['pointer','pointer','pointer','pointer','uint32'])(runner.readPointer(),job,source,function64,1);
   if(!function64.add(0x38).readPointer().isNull())throw Error('E_FUNCTION_NOT_TRANSFERRED');
  }catch(error){failQueue(error);}
  finally{
   let cleanupError=null;for(const p of [job,runner]){try{release(p);}catch(error){cleanupError??=error;}}
   if(cleanupError)failQueue(cleanupError);
  }
 });
}
function currentTask() {const p=pair();try{fn(0x48af50,'pointer',['pointer'])(p);if(p.readPointer().isNull())throw Error('E_NATIVE_TASK_SCOPE');return p;}catch(error){release(p);throw error;}}
function releaseMany(pairs){let failure=null;for(const p of pairs){try{release(p);}catch(error){failure??=error;}}if(failure)throw failure;}

// Embeddable fragment for agents/send-native.js; no RPC, hook, queue, or call runs on load.
// Static research against Weixin.dll 4.1.15.13, SHA-256:
// 10f8e995453e2da46d4f2b5080cd6da1f13cc5147746adc119ceae38cb039de5.
// Requires the existing PREFIX/fn/pair/release/currentTask/moduleVerified/binding helpers.
// Invoke only after prepare, inside `await queue(() => cachedContacts())`.
Object.assign(PREFIX, {
 '36c7b0':'56 57 53 48 83 ec 40 48 89 d6 48 89 cf',
 '6dcf80':'56 57 48 83 ec 38 48 89 d6 48 8d 05 a8 38 72 08',
 '74ac908':'33 d2 e9 41 00 00 00',
 '74ac930':'48 83 ec 28 83 69 4c 01 75 0e 83 49 48 ff 48 83',
 '74ac950':'48 89 5c 24 10 48 89 6c 24 18 48 89 74 24 20 57',
});

let lastContactPhase='idle',contactSnapshotValidated=false;
function cachedContacts() {
 lastContactPhase='binding';
 if (!binding || binding.pid !== Process.id) throw Error('E_CONTACTS_BINDING');
 const capturedBinding = binding, generation = binding.generation;
 const module = moduleVerified(), base = module.base;
 const storeGetter = fn(0x6dcf80, 'pointer', ['pointer', 'pointer']);
 const lock = fn(0x74ac908, 'int', ['pointer']);
 const unlock = fn(0x74ac930, 'int', ['pointer']);
 // Prove the leaf jump destination before calling the mutex wrapper.
 fn(0x74ac950, 'int', ['pointer', 'pointer']);
 lastContactPhase='system-module';
 const kernel32 = Process.enumerateModules().find(m => m.name.toLowerCase() === 'kernel32.dll');
 if (!kernel32) throw Error('E_CONTACTS_SYSTEM_MODULE');
 const imports = [
  [0x9c6ce88, 'AcquireSRWLockExclusive'], [0x9c6d158, 'GetCurrentThreadId'],
  [0x9c6d640, 'ReleaseSRWLockExclusive'], [0x9c6d7f0, 'TryAcquireSRWLockExclusive'],
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
  fn(0x48af50, 'pointer', ['pointer'])(task);
  if (task.readPointer().isNull()) throw Error('E_NATIVE_TASK_SCOPE');
  lastContactPhase='account';
  fn(0x47220, 'pointer', ['pointer'])(account);
  const accountPointer = account.readPointer();
  if (accountPointer.isNull() || accountPointer.toString() !== capturedBinding.account)
   throw Error('E_ACCOUNT_OR_TARGET_CHANGED');
  readable(accountPointer, 0x470);
  if (!accountPointer.readPointer().equals(base.add(0x8dfe2f8))) throw Error('E_CONTACTS_ACCOUNT_TYPE');
  const center = readable(accountPointer.add(0x460).readPointer(), 0xc8);
  const centerControl = readable(accountPointer.add(0x468).readPointer(), 0x10);
  if (!center.readPointer().equals(base.add(0x8f9bf98)) || centerControl.add(8).readS32() <= 0)
   throw Error('E_CONTACTS_CACHE_CENTER_TYPE');
  lastContactPhase='registry';
  // This is account.vtable+0x38. The ordinary service container at +0x28 is a different type.
  // The center is already nonempty; the getter cannot enter its lazy factory branch here.
  fn(0x36c7b0, 'pointer', ['pointer', 'pointer'])(accountPointer, registry);
  if (registry.readPointer().isNull()) throw Error('E_CONTACTS_REGISTRY');
  if (!registry.readPointer().equals(center) || !registry.readPointer().readPointer().equals(base.add(0x8f9bf98))) throw Error('E_CONTACTS_CACHE_CENTER_TYPE');
  lastContactPhase='store';
  storeGetter(registry.readPointer(), storePair);
  const store = readable(storePair.readPointer(), 0x1f0);
  if (storePair.add(8).readPointer().isNull() || !store.readPointer().equals(base.add(0x8fa2538)))
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
        afterAccount.readPointer().toString() !== capturedBinding.account) throw Error('E_ACCOUNT_OR_TARGET_CHANGED');
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

let knownContacts=new Set();
async function contactsSnapshot() { if(!binding||runtimeBlocked) throw Error('E_READ_NOT_READY'); const result=await queue(() => {verifyAccount();return cachedContacts();}); knownContacts=new Set(result.contacts.map(row=>row.username));contactSnapshotValidated=true; return {pid:Process.id,self:binding.self,...result,automaticMessagesSent:0}; }

async function accountLayout(){if(!binding)throw Error('E_BINDING');return await queue(()=>{const task=currentTask(),account=pair();try{fn(0x47220,'pointer',['pointer'])(account);const p=account.readPointer();if(p.isNull()||p.toString()!==binding.account)throw Error('E_ACCOUNT');const m=moduleVerified(),v=p.readPointer(),f=v.add(0x38).readPointer();if(v.compare(m.base)<0||v.compare(m.base.add(m.size))>=0||f.compare(m.base)<0||f.compare(m.base.add(m.size))>=0)throw Error('E_ACCOUNT_TYPE');return {accountVtableRva:v.sub(m.base).toString(),getterSlot38Rva:f.sub(m.base).toString(),nativeSendCalled:false};}finally{release(account);release(task);}});}

function identityFromOwner(owner){
 const p=readable(owner.readPointer(),0x88),m=moduleVerified();
 if(!p.readPointer().equals(m.base.add(0x8dfe2f8))||owner.add(8).readPointer().isNull())throw Error('E_ACCOUNT_TYPE');
 // Account::username at vtable+0x18; its source is the current login profile's first string.
 // Do not inspect neighbouring account configuration strings.
 const self=text(p.add(0x48),256);
 if(!/^[A-Za-z0-9_.:@-]{1,256}$/.test(self))throw Error('E_ACCOUNT_ID');
 return {account:p.toString(),self};
}
function verifyAccount(){
 if(!binding)throw Error('E_READ_BINDING');const task=currentTask(),owner=pair();
 try{fn(0x47220,'pointer',['pointer'])(owner);const proof=identityFromOwner(owner);if(proof.account!==binding.account||proof.self!==binding.self)throw Error('E_ACCOUNT_CHANGED');return proof;}finally{releaseMany([owner,task]);}
}
function selfContact(owner,self){
 const registry=pair(),service=pair(),contact=pair(),username=Memory.alloc(32);let constructed=false;
 try{
  fn(0x88ad0,'pointer',['pointer','pointer'])(username,Memory.allocUtf8String(self));constructed=true;
  fn(0x36c740,'pointer',['pointer','pointer'])(owner.readPointer(),registry);
  if(registry.readPointer().isNull())throw Error('E_ACCOUNT_SERVICE_REGISTRY');
  fn(0x460a40,'pointer',['pointer','pointer'])(registry.readPointer(),service);
  if(service.readPointer().isNull())throw Error('E_ACCOUNT_CONTACT_SERVICE');
  fn(0x100a690,'pointer',['pointer','pointer','pointer'])(service.readPointer(),contact,username);
  if(contact.readPointer().isNull())return {displayName:'（当前账号）',nameAvailable:false};
  const p=readable(contact.readPointer(),0xf8);
  if(contact.add(8).readPointer().isNull()||text(p.add(8),256)!==self)throw Error('E_SELF_CONTACT_IDENTITY');
  const nickname=text(p.add(0xd8)),remark=text(p.add(0x78));
  return {displayName:nickname||remark||'（当前账号）',nameAvailable:Boolean(nickname||remark)};
 }finally{try{if(constructed)fn(0x2010,'void',['pointer'])(username);}finally{releaseMany([contact,service,registry]);}}
}
function accountData(){
 const task=currentTask(),owner=pair(),after=pair();
 try{
  fn(0x47220,'pointer',['pointer'])(owner);const proof=identityFromOwner(owner);
  if(binding&&(proof.account!==binding.account||proof.self!==binding.self))throw Error('E_ACCOUNT_CHANGED');
  const profile=selfContact(owner,proof.self);
  fn(0x47220,'pointer',['pointer'])(after);const current=identityFromOwner(after);
  if(current.account!==proof.account||current.self!==proof.self)throw Error('E_ACCOUNT_CHANGED');
  return {...proof,...profile};
 }finally{releaseMany([after,owner,task]);}
}
let historyValidated=false,runtimeBlocked=false;
function inspect(){
 moduleVerified();for(const key of Object.keys(PREFIX))fn(parseInt(key,16),'void',[]);
 return {pid:Process.id,generation:binding?.generation??null,self:binding?.self??null,version:'4.1.15.13',dllSha256:VERIFIED_DLL_SHA256,
  ready:binding!==null&&!runtimeBlocked,accountVerified:binding!==null,readScopeVerified:binding!==null,runtimeBlocked,
  historyAvailable:historyValidated,pendingTasks:[...tasks.values()].filter(r=>!r.completed&&!r.error&&!r.cancelled).length,pendingCallbacks:[...historyCallbacks.values()].filter(r=>!r.completed).length,
  contactSnapshotAvailable:contactSnapshotValidated,foregroundRequired:false,automaticMessagesSent:0};
}
async function prepare(config){
 if(binding||runtimeBlocked)throw Error('E_ALREADY_BOUND');
 if(config?.pid!==Process.id||config.dllSha256!==VERIFIED_DLL_SHA256||!/^[-a-f0-9]{36}$/i.test(config.generation??''))throw Error('E_READ_BINDING');
 const proof=await queue(()=>accountData());
 binding={pid:Process.id,generation:config.generation,...proof};
 return inspect();
}
async function account(){if(!binding||runtimeBlocked)throw Error('E_READ_NOT_READY');const proof=await queue(()=>accountData());return {pid:Process.id,generation:binding.generation,source:'reverse-native',scope:'current-account',self:proof.self,displayName:proof.displayName,nameAvailable:proof.nameAvailable,accountVerified:true,automaticMessagesSent:0};}

// message::list_messages business ABI; typed input is borrowed until return.
// Callee owns/destroys callback result, so all bounded DTO copies happen inside invoke.
PREFIX['5476170']='55 41 57 41 56 41 55 41 54 56 57 53 48 81 ec 58 03 00 00 48 8d ac 24 80 00 00 00 0f 29 bd c0 02';
const historyCallbacks=new Map();let nextHistory=0;
function flag(p){readable(p,1);const v=p.readU8();if(v!==0&&v!==1)throw Error('E_HISTORY_FLAG');return v===1;}
function vector(p,stride,max,label='vector'){
 readable(p,24,label+'-header');const begin=p.readPointer(),end=p.add(8).readPointer(),cap=p.add(16).readPointer();
 if(begin.isNull()){if(!end.isNull()||!cap.isNull())throw Error('E_HISTORY_VECTOR');return {begin,count:0};}
 if(end.compare(begin)<0||cap.compare(end)<0)throw Error('E_HISTORY_VECTOR');
 const bytes=end.sub(begin).toUInt32();if(!end.equals(begin.add(bytes))||bytes%stride!==0||bytes/stride>max)throw Error('E_HISTORY_VECTOR_LIMIT');
 if(bytes)readable(begin,bytes,label+'-data');return {begin,count:bytes/stride};
}
function decodeHistory(value,input){
 readable(value,0x68,'result');
 if(!flag(value))throw Error(flag(value.add(0x28))?'E_HISTORY_NATIVE_FAILED:'+text(value.add(8),4096):'E_HISTORY_NATIVE_FAILED');
 const self=text(value.add(0x30),256,'result-self');if(self!==binding.self)throw Error('E_HISTORY_ACCOUNT_SCOPE');
 const groups=vector(value.add(0x50),0x90,1,'groups'),messages=[];let bytes=0;
 for(let g=0;g<groups.count;g++){
  const group=groups.begin.add(g*0x90),chatId=text(group,256,'group-chat');
  if(chatId!==input.to)throw Error('E_HISTORY_CHAT_SCOPE');
  const rows=vector(group.add(0x78),0xc0,input.limit,'messages');
  for(let i=0;i<rows.count;i++){
   const p=rows.begin.add(i*0xc0),serverId=p.readU64().toString(),type=p.add(8).readU64().toString(),createTime=p.add(0x20).readU64().toString();
   if(!/^\d{1,20}$/.test(serverId)||!/^\d{1,10}$/.test(type)||!/^\d{1,10}$/.test(createTime))throw Error('E_HISTORY_INTEGER');
   const content=flag(p.add(0x48))?text(p.add(0x28),262144,'content'):'',senderUsername=text(p.add(0x50),256,'sender');
   if(senderUsername&&!/^[A-Za-z0-9_.:@-]{1,256}$/.test(senderUsername))throw Error('E_HISTORY_SENDER');
   const senderName=flag(p.add(0x90))?text(p.add(0x70),16384,'sender-name'):undefined;
   bytes+=content.length*4+(senderName?.length??0)*4;if(bytes>3*1024*1024)throw Error('E_HISTORY_BYTE_LIMIT');
   // Raw XML is intentionally disabled at the native query boundary.
   if(flag(p.add(0xb8)))throw Error('E_HISTORY_XML_UNEXPECTED');
   messages.push({serverId,type,createTime,content,senderUsername,...(senderName===undefined?{}:{senderName}),...(flag(p.add(0x18))?{subType:p.add(0x10).readU64().toString()}:{})});
  }
 }
 return {pid:Process.id,generation:binding.generation,self,chatId:input.to,source:'reverse-native',messages,schemaValidated:true,automaticMessagesSent:0};
}
function nativeHistory(input,isCancelled){
 const id=String(++nextHistory),typed=Memory.alloc(0x60),chat=Memory.alloc(32),correlation=Memory.alloc(32),handle=Memory.alloc(8),object=Memory.alloc(24);
 typed.writeByteArray(new Uint8Array(0x60));object.writeByteArray(new Uint8Array(24));
 const keep={typed,chat,correlation,handle,object,code:[],constructed:0,entered:false,completed:false};historyCallbacks.set(id,keep);
 const result=new Promise((resolve,reject)=>{keep.resolve=resolve;keep.reject=reject;});
 function finish(error,value){if(keep.completed)return;keep.completed=true;clearTimeout(keep.timer);if(error)keep.reject(error);else keep.resolve(value);}
 const invoke=new NativeCallback((_self,value)=>{if(keep.completed)return;if(keep.callbackSeen){keep.error=Error('E_HISTORY_DUPLICATE_CALLBACK');return;}keep.callbackSeen=true;try{keep.value=decodeHistory(value,input);}catch(error){keep.error=error;}},'void',['pointer','pointer'],'win64');
 const destroy=new NativeCallback(()=>{keep.destroyed=true;setTimeout(()=>historyCallbacks.delete(id),1000);},'void',['pointer'],'win64');
 keep.code.push(invoke,destroy);object.writeS32(1);object.add(8).writePointer(invoke);object.add(16).writePointer(destroy);handle.writePointer(object);
 const ctor=fn(0x88ad0,'pointer',['pointer','pointer']),dtor=fn(0x2010,'void',['pointer']);
 try{
  const query=fn(0x5476170,'void',['pointer','pointer','pointer','pointer']);
  ctor(chat,Memory.allocUtf8String(input.to));keep.constructed=1;
  ctor(correlation,Memory.allocUtf8String('wxcc-read-'+id));keep.constructed=2;
  typed.writePointer(chat);typed.add(8).writePointer(chat.add(32));typed.add(16).writePointer(chat.add(32));
  typed.add(0x48).writeS32(input.limit);typed.add(0x54).writeU8(0);typed.add(0x58).writeU8(1);
  // Memory.alloc() regions can be cloaked from Process.findRangeByAddress.
  // This 32-byte header is our own pinned allocation; only an external heap buffer needs range checks.
  const n=chat.add(16).readU64().toNumber(),capacity=chat.add(24).readU64().toNumber();
  if(n!==unescape(encodeURIComponent(input.to)).length||!Number.isSafeInteger(capacity)||capacity<n||capacity>1048576||(capacity<16&&capacity!==15))throw Error('E_HISTORY_INPUT_LAYOUT');
  const data=capacity<16?chat:readable(chat.readPointer(),n+1,'input-chat-data');
  if(data.add(n).readU8()!==0||data.readUtf8String(n)!==input.to)throw Error('E_HISTORY_STRING_ROUNDTRIP');
  if(isCancelled())throw Error('E_TASK_CANCELLED');
  verifyAccount();
  if(isCancelled())throw Error('E_TASK_CANCELLED');
  keep.timer=setTimeout(()=>{runtimeBlocked=true;finish(Error('E_HISTORY_TIMEOUT_UNKNOWN'));},12000);
  keep.entered=true;query(ptr(0),typed,correlation,handle);
 }catch(error){if(keep.entered)runtimeBlocked=true;keep.error=error;}
 finally{
  const cleanups=[];if(keep.constructed>=2)cleanups.push(()=>dtor(correlation));if(keep.constructed>=1)cleanups.push(()=>dtor(chat));
  // Native entry consumes the intrusive owner on success and error; never release twice after entry.
  if(!keep.entered)cleanups.push(()=>{if(!handle.readPointer().isNull()){fn(0x107050,'void',['pointer'])(handle);handle.writePointer(ptr(0));}});
  for(const cleanup of cleanups){try{cleanup();}catch(error){runtimeBlocked=true;keep.error??=error;}}
 }
 if(!keep.callbackSeen&&!keep.error){runtimeBlocked=true;keep.error=Error('E_HISTORY_CALLBACK_UNKNOWN');}
 finish(keep.error,keep.value);
 return result;
}
async function history(input){
 if(!binding||runtimeBlocked)throw Error('E_READ_NOT_READY');
 if(!input||typeof input.to!=='string'||!Number.isInteger(input.limit)||input.limit<1||input.limit>200||
    (!knownContacts.has(input.to)&&input.to!==binding.self))throw Error('E_HISTORY_TARGET');
 const pending=await queue(isCancelled=>({promise:nativeHistory(input,isCancelled)}));
 const result=await pending.promise;if(runtimeBlocked)throw Error('E_READ_NOT_READY');await queue(()=>verifyAccount());historyValidated=true;return result;
}
rpc.exports={inspect,prepare,account,contacts:contactsSnapshot,history};

