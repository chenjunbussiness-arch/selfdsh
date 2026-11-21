/**
 * Panel copy, Chinese and English.
 *
 * Registered through `ctx.locale.register`, so the shell's locale switch and its
 * `en` fallback both work. Keys are flat and dot-namespaced; `{name}` is the
 * shell's interpolation syntax.
 */
/** Namespace id. */
export declare const NS = "egress.panel";
declare const zh: {
    readonly 'panel.title': "出口";
    readonly 'panel.subtitle': "为每个模型端点选择出站代理";
    readonly 'badge.mock': "示例数据";
    readonly 'badge.mock.hint': "宿主侧的出口桥没有接通，下面是内置示例数据，改动不会保存";
    readonly refresh: "刷新";
    readonly refreshing: "刷新中…";
    readonly 'done.exitAdded': "已添加出口「{name}」";
    readonly 'done.exitSaved': "已保存出口「{name}」";
    readonly 'done.exitDeleted': "已删除出口「{name}」";
    readonly 'done.bound': "{host} 改走「{exit}」，下一条请求生效";
    readonly 'done.unbound': "{host} 已取消绑定，改走默认出口";
    readonly 'done.default': "默认出口已改为「{exit}」";
    readonly 'form.hint.paste': "可以直接粘贴整条代理地址，例如 socks5://用户:密码@主机:1080";
    readonly 'log.count': "显示 {shown}/{total}";
    readonly retry: "重试";
    readonly loading: "正在读取…";
    readonly 'error.load': "读取失败：{message}";
    readonly 'status.instant': "即时生效";
    readonly 'status.instant.hint': "保存后下一条模型请求就走新出口，不用重启 dsh-web";
    readonly 'status.restart': "需重启 dsh-web";
    readonly 'status.restart.hint': "请求钩子没有生效（插件刚安装，或被其它代码覆盖）。请在服务器上执行 {cmd}。本面板不会自己重启。";
    readonly 'status.corrupt': "配置文件无法读取，所有非本机请求已被拦截：{error}";
    readonly 'status.undici': "找不到 undici，走代理的请求会直接失败（不会直连）：{error}";
    readonly 'status.failclosed': "失败即断：出口不通时请求直接报错，不会回退直连";
    readonly 'status.copy': "复制命令";
    readonly 'status.copied': "已复制";
    readonly 'exits.title': "出口";
    readonly 'exits.add': "添加出口";
    readonly 'exits.empty': "还没有自定义出口。点「添加出口」配置一个 http、https 或 socks5 代理。";
    readonly 'exit.builtin': "内置";
    readonly 'exit.default': "默认";
    readonly 'exit.probe': "探测";
    readonly 'exit.probing': "探测中…";
    readonly 'exit.edit': "编辑";
    readonly 'exit.delete': "删除";
    readonly 'exit.confirm': "确认删除";
    readonly 'exit.cancel': "取消";
    readonly 'exit.noProbe': "未探测";
    readonly 'exit.probeOk': "出口 IP {ip} · {ms} ms";
    readonly 'exit.probeFail': "失败：{error}";
    readonly 'exit.auth': "有认证";
    readonly 'exit.direct.desc': "服务器自己的网络，不经过代理";
    readonly 'form.new': "添加出口";
    readonly 'form.edit': "编辑出口";
    readonly 'form.name': "名称";
    readonly 'form.type': "类型";
    readonly 'form.host': "主机";
    readonly 'form.port': "端口";
    readonly 'form.username': "用户名";
    readonly 'form.password': "密码";
    readonly 'form.optional': "可选";
    readonly 'form.keep': "留空则保留原密码";
    readonly 'form.clearAuth': "清除认证";
    readonly 'form.hasAuth': "已设置认证";
    readonly 'form.save': "保存";
    readonly 'form.saving': "保存中…";
    readonly 'form.cancel': "取消";
    readonly 'form.hint.socks5': "socks5 由代理解析域名（socks5h）";
    readonly 'form.hint.secret': "认证只保存在服务器上权限 0600 的文件里，不会回传到浏览器。";
    readonly 'form.err.name': "请填写名称";
    readonly 'form.err.host': "请填写主机";
    readonly 'form.err.port': "端口需要是 1 到 65535 的整数";
    readonly 'bind.title': "绑定";
    readonly 'bind.subtitle': "每个模型端点主机走哪个出口";
    readonly 'bind.host': "目标主机";
    readonly 'bind.exit': "出口";
    readonly 'bind.default': "默认出口";
    readonly 'bind.default.hint': "没有单独绑定的主机走这里";
    readonly 'bind.source.binding': "已绑定";
    readonly 'bind.source.default': "跟随默认";
    readonly 'bind.unbind': "取消绑定";
    readonly 'bind.addHost': "添加主机";
    readonly 'bind.addHost.placeholder': "例如 api.example.com";
    readonly 'bind.lastSeen': "最近请求 {time}";
    readonly 'bind.neverSeen': "尚无请求";
    readonly 'log.title': "最近请求";
    readonly 'log.hint': "最近 100 条，只记主机、出口和结果，不记内容和密钥";
    readonly 'log.empty': "还没有请求经过本插件";
    readonly 'log.ok': "成功";
    readonly 'log.fail': "失败";
    readonly 'log.show': "展开";
    readonly 'log.hide': "收起";
};
/** Dictionaries keyed by locale id. */
export declare const DICTIONARIES: {
    readonly zh: Record<string, string>;
    readonly en: Record<string, string>;
};
/** Dictionary key. */
export type LocaleKey = keyof typeof zh;
export {};
