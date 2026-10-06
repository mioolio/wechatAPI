// This agent only observes module metadata. It invokes no Weixin business API.
rpc.exports = {
  inspect() {
    const main = Process.findModuleByName('Weixin.dll');
    return {
      pid: Process.id,
      architecture: Process.arch,
      pointerSize: Process.pointerSize,
      mainModule: main ? { name: main.name, path: main.path, base: main.base.toString(), size: main.size } : null,
      modules: Process.enumerateModules().map(m => ({ name: m.name, path: m.path, base: m.base.toString(), size: m.size })),
      exports: main ? main.enumerateExports().map(e => ({ name: e.name, type: e.type, address: e.address.toString(), rva: e.address.sub(main.base).toString() })) : []
    };
  }
};
