# dsh-warroom 插件 UI 规范（DeepSeek 原生风格）

适用于所有 `plugins/*/packages/client-ui-*`。参考实现：`plugins/dsh-vpn/packages/client-ui-vpn/src/client/styles.ts`。

## 1. 原则
- **只用一个主色** `#4d6bfe`。状态色（成功、警告、错误、空闲）只用于状态点、徽标和提示，不做大面积底色。
- **靠底色深浅和间距区分层次，不画边框**。卡片用 `fill` 底色；浮层用 0.5px 阴影描边加柔和阴影。不用 1px 实线框，也不用分隔线。
- 留白要多，信息层级要清楚：页面标题，然后是区块小标题（12px、三级文字色），最后是内容。
- 颜色全部取 DSH 主题变量，后面写上浅色主题的默认值，这样深色和浅色模式会自动跟着切换。
- 每个插件保留自己的类名前缀（如 `dshv-`、`dshe-`、`dshr-`、`dah-`），但**变量名后缀、数值和组件写法必须和本规范一致**。

## 2. 变量（以 `<p>` 代表各插件前缀）
```css
--<p>-accent: #4d6bfe;
--<p>-accent-soft: color-mix(in srgb, var(--<p>-accent) 11%, transparent);
--<p>-text:   var(--dsw-alias-label-primary, #0f1115);
--<p>-text-2: var(--dsw-alias-label-secondary, #61666b);
--<p>-text-3: var(--dsw-alias-label-tertiary, #81858c);
--<p>-line:   var(--dsw-alias-border-l, #e1e5ee);
--<p>-base:   var(--dsw-alias-bg-base, #fff);
--<p>-fill:   var(--dsw-alias-bg-layer-1, #f9fafb);
--<p>-fill-2: var(--dsw-alias-bg-layer-2, #f5f7fa);
--<p>-hover:  var(--dsw-alias-interactive-bg-hover, rgba(15,17,21,.05));
--<p>-ok:   var(--dsw-alias-state-success-primary, #22c55e);
--<p>-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
--<p>-bad:  var(--dsw-alias-state-error-primary, #ec1313);
--<p>-idle: var(--dsw-alias-state-idle-primary, #d4d4d4);
--<p>-mono: var(--dsh-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
```
禁止写死 `#fff`、`#000`、`gray` 这类颜色（只有放在 `var()` 里作为默认值时可以）。

## 3. 尺寸
| 项 | 值 |
|---|---|
| 字号 | 正文 14 / 22，次要文字 13–13.5，辅助说明 12–12.5，页面标题 24 / 32（600），卡片标题 17 / 26（600），大数字 28 / 36（600） |
| 圆角 | 大卡片 24，中卡片和统计格 14–16，按钮和输入框 12 或 999（胶囊），列表行 12 |
| 间距 | 页面内容区最大宽度 820–1100（表格页可以宽一些），左右内边距 24，区块之间 20，卡片内边距 24 / 26 |
| 按钮 | 高 38（小号 30），胶囊形；默认用 `hover` 底色，主按钮用 `accent` 底色加白字，危险按钮用 `bad` 12% 底色加红字 |
| 输入框 | 高 40，无边框，`fill` 底色，获得焦点时显示 1.5px 主色描边 |
| 状态点 | 8×8 圆点，颜色用 `--<p>-tone` |
| 动效 | 0.15s 背景和透明度过渡；需要兼容 `prefers-reduced-motion` |

## 4. 组件写法（照 VPN 抄）
- **左侧栏**（列表页）：宽 272，`fill` 底色；条目圆角 12，悬停用 `hover`，选中用 `accent-soft` 并且文字变主色。
- **状态卡**：圆角 24，底色是 `color-mix(tone 7%, fill)`，左边一个圆点，右边是大号状态文字。
- **统计格**：网格布局，每格 `base` 或 `fill` 底色，圆角 14；上面一行 12px 标签，下面一行数值（等宽字体）。
- **表格**：不画竖线，也不画横线；表头 12px、三级文字色；行高 44 左右，悬停用 `hover`，整行圆角 12；数字和 ID 用等宽字体。
- **标签（chip）**：高 26，胶囊形，`base` 或 `fill` 底色，12.5px。
- **分段切换**：`fill` 底的胶囊；选中项用 `base` 底，主色加粗，带轻阴影。
- **提示框**：圆角 14；错误用 `bad` 9%，警告用 `warn` 12%，跟 `base` 混色。
- **空状态和加载中**：居中，三级文字色，13px，可以配一个弱化的图标，不要整块灰框。
- **响应式**：用 `container-type: inline-size`，宽度不到 760 时改成单列。

## 5. 不要做的
- 1px 实线边框、表格网格线、浓重阴影、渐变色块。
- 一个页面里出现多个高饱和主色。
- 改数据流、接口、文案 key 或业务逻辑（UI 优化只动样式、DOM 结构和类名）。
