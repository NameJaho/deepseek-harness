import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it, onTestFinished } from 'vitest'

const execFileAsync = promisify(execFile)
const packageDir = fileURLToPath(new URL('..', import.meta.url))

it.skipIf(process.platform === 'win32')('runs PTC through the published container runner with an attachment fixture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-container-built-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const runtime = join(root, 'runtime')
  const fixture = await readFile(new URL('./fixtures/runtime.mjs', import.meta.url), 'utf8')
  await writeFile(runtime, `#!${process.execPath}\n${fixture}`, { mode: 0o700 })
  const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', `
    const {Context}=await import('@deepseek-ai/cordis');
    const ctx=new Context();
    try {
      for(const name of ['session','fs-local','subprocess-local','session-projection']) {
        const {default: plugin}=await import('@deepseek-ai/dsh-'+name); await ctx.plugin(plugin);
      }
      const {default: Sandbox}=await import('@deepseek-ai/dsh-sandbox-container');
      await ctx.plugin(Sandbox,{runtime:${JSON.stringify(runtime)},image:'fixture',nodeExecutable:process.execPath,user:'1:1',workspaceRoots:[${JSON.stringify(root)}]});
      const {default: Policy}=await import('@deepseek-ai/dsh-sandbox-policy');
      await ctx.plugin(Policy,{mode:'workspace-write',workspaceRoot:${JSON.stringify(root)}});
      const {default: Ptc}=await import('@deepseek-ai/dsh-ptc-runtime-node'); await ctx.plugin(Ptc,{});
      const result=await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({
        cwd:${JSON.stringify(root)},program:'return await tools.double({n:21})',
        bindings:[{global:'tools',functions:{double:async({n})=>n*2}}]
      }));
      console.log(JSON.stringify(result));
    } finally {await ctx.fiber.dispose();}
  `], { cwd: packageDir, timeout: 55_000 })
  const lines = result.stdout.trim().split('\n')
  const output: unknown = JSON.parse(lines.at(-1) ?? '{}')
  expect(output, result.stderr).not.toHaveProperty('error')
  expect(output).toMatchObject({ value: 42 })
})

it.skipIf(!process.env.DSH_CONTAINER_TEST_IMAGE || process.platform === 'win32')('runs PTC in a real deployment image', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-container-real-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', `
    const {Context}=await import('@deepseek-ai/cordis');const ctx=new Context();
    try {
      for(const name of ['session','fs-local','subprocess-local','session-projection']) {
        const {default: plugin}=await import('@deepseek-ai/dsh-'+name);await ctx.plugin(plugin);
      }
      const {default: Sandbox}=await import('@deepseek-ai/dsh-sandbox-container');
      await ctx.plugin(Sandbox,{
        image:${JSON.stringify(process.env.DSH_CONTAINER_TEST_IMAGE)},
        runtime:${JSON.stringify(process.env.DSH_CONTAINER_RUNTIME ?? 'docker')},
        nodeExecutable:${JSON.stringify(process.env.DSH_CONTAINER_NODE_EXECUTABLE ?? '/usr/local/bin/node')},
        user:process.getuid()+':'+process.getgid(),workspaceRoots:[${JSON.stringify(root)}],
        readOnlyRoots:${JSON.stringify(['packages', 'vendor', 'node_modules'].map(name => fileURLToPath(new URL(`../../../../${name}`, import.meta.url))))}
      });
      const {default: Policy}=await import('@deepseek-ai/dsh-sandbox-policy');
      await ctx.plugin(Policy,{mode:'workspace-write',workspaceRoot:${JSON.stringify(root)}});
      const {default: Ptc}=await import('@deepseek-ai/dsh-ptc-runtime-node');await ctx.plugin(Ptc,{});
      const result=await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({cwd:${JSON.stringify(root)},
        program:${JSON.stringify(`const n=await tools.double({n:21}); const fs=await import("node:fs/promises"); await fs.writeFile("result.txt",String(n)); const rootVisible=await fs.stat(${JSON.stringify(fileURLToPath(new URL('../../../../package.json', import.meta.url)))}).then(()=>true,error=>{if(error.code!=="ENOENT") throw error; return false}); return {n,cwd:process.cwd(),rootVisible}`)},
        bindings:[{global:'tools',functions:{double:async({n})=>n*2}}]
      }));console.log(JSON.stringify(result));
    }finally {await ctx.fiber.dispose();}
  `], { cwd: packageDir, timeout: 55_000 })
  const output: unknown = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}')
  expect(output, result.stderr).not.toHaveProperty('error')
  expect(output).toMatchObject({ value: { n: 42, cwd: root, rootVisible: false } })
  expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('42')
})
