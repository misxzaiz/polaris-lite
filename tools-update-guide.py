import io, json, re, pathlib
kt_old = pathlib.Path('ext-plugins-src/plite-guide/knowledge.ts')
old = kt_old.read_text(encoding='utf-8')
new_ports = """  {
    id: 'overview-instances',
    section: 'ops',
    title: '实例与发版纪律',
    summary: '5000=开发，9825=生产，9826=钉住分析实例；判断环境只看端口。',
    body: [
      '· 5000 开发环境：npm run dev:standalone 启动；数据目录 .polaris-lite-dev/。开发调试一律用它。',
      '· 9825 生产环境：npm run build && npm start；数据目录 .polaris-lite/。生产只读观察，禁止把测试数据写进去。',
      '· 9826 分析实例：代码在独立 clone polaris-lite-9826，数据目录 .polaris-lite-pm2/，PM2 托管；升级走 npm run deploy:9826。',
      '· 发版：一律 npm run release（自动 commit→push→deploy:9826→build+restart 9825→三处一致性终检）。禁止手工拼 deploy/build/restart 组合，会出现版本漂移。',
      '· 运行态数据目录（.polaris-lite*）不入库；账号/密码/密钥等敏感信息不属于插件说明范畴。',
    ].join('\\n'),
  },"""
pat_block = re.compile(r"  \{\n    id: 'overview-ports',.*?\n  \},", re.S)
assert pat_block.search(old), 'overview-ports block not found'
old = pat_block.sub(lambda _: new_ports, old, count=1)
kt_old.write_text(old, encoding='utf-8')
print('knowledge.ts updated')

src = pathlib.Path('ext-plugins-src/plite-guide/knowledge.ts').read_text(encoding='utf-8')
docs = []
blocks = re.split(r"\n  \{\n", src)
pat_field = re.compile("(id|section|title|summary): '([^']*)'")
pat_body = re.compile(r"body: (\[[^\]]*\]|'(?:[^'\\]|\\.)*')", re.S)
pat_part = re.compile(r"'((?:[^'\\]|\\.)*)'")
for b in blocks[1:]:
    if "id: '" not in b:
        continue
    fields = dict(pat_field.findall(b))
    bm = pat_body.search(b)
    body_raw = bm.group(1)
    if body_raw.startswith('['):
        parts = pat_part.findall(body_raw)
        body = '\n'.join(p.replace('\\n', '\n') for p in parts)
    else:
        body = body_raw[1:-1].replace('\\n', '\n')
    docs.append({'id': fields['id'], 'section': fields['section'], 'title': fields['title'], 'summary': fields['summary'], 'body': body})
print('docs:', [d['id'] for d in docs])
bad = [d['id'] for d in docs if ('账号' in d['body'] or '密码' in d['body'] or '1234' in d['body'])]
assert not bad, f'账号信息残留: {bad}'

ms = pathlib.Path('ext-plugins-src/plite-guide/mcp-server.mjs')
s = ms.read_text(encoding='utf-8')
i = s.find('const DOCS = ')
j = s.find('];', i) + 2
s = s[:i] + 'const DOCS = ' + json.dumps(docs, ensure_ascii=False, indent=2) + ';' + s[j:]
ms.write_text(s, encoding='utf-8')
print('mcp-server DOCS refreshed')
