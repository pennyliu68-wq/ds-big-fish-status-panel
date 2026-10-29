# 状态台（dsh-paofu-console）

**DeepSeek Harness 插件版**。装上以后 DSH 里多一个地址：

```
<你的 DSH 地址>/dsh-paofu-console/
```

打开就是整块状态台：在线状态、未读数、用量与余额、表情库、记忆、小说、技能、承诺、时间线。

- **零依赖**，纯 Node 标准库，`npm install` 都不用跑
- **自带数据服务**：插件自己在本机回环起一个服务（默认端口 9896），不用另开命令行
- **只读**：不调用模型、不改文件（只有「刷新」和表情上传会动自己的 `data/`）
- 没有桥接也能跑，只是在线、未读那几块空着

---

## 最省事：把一句话贴给 DSH

解压后，在 **DSH 里新建一个对话**，把下面这段原样贴进去，把尖括号换成你解压出来的实际位置：

> 我解压了一个 DSH 插件 `dsh-paofu-console` 在 `<把解压后的完整路径贴这里>`。
> 帮我：1）复制到我当前的 DSH profile 的 `node_modules` 下；2）在 profile 的 `package.json` 里把
> `dsh-paofu-console` 加进 `dependencies` 和 `dsh.profile.bundles`；3）重启后告诉我
> `<DSH地址>/dsh-paofu-console/` 能不能打开、有没有报错。

DSH 会自己找 profile、改包清单、重启验证。人只需要看最后一句结果。

**如果 DSH 说找不到 profile**，把下面这句也贴给它：

> 用 `dsh doctor`，或者看一眼 `%USERPROFILE%\.dsh\profiles` 下面有哪些目录，挑里面有 `package.json` 和 `node_modules` 的那个。

下面是手动装的完整步骤，装不上时对着查。

---

## 手动安装

### 第一步：确认 Node 版本

```bash
node -v
```

要 **20 或更高**。没有的话去 <https://nodejs.org> 装 LTS 版。

### 第二步：找到你的 DSH profile 目录

一般在这两个位置之一：

```
%USERPROFILE%\.dsh\profiles\desktop
%USERPROFILE%\.dsh\profiles\web
```

看哪个目录里有 `package.json` 和 `node_modules` 就是它（桌面版通常是 `desktop`）。

### 第三步：放进 node_modules

把整个 `dsh-paofu-console` 文件夹复制到：

```
<profile目录>\node_modules\dsh-paofu-console\
```

**或者**直接交给 DeepSeek Harness 处理，把下面这段话贴给它：

> 我解压了一个 DSH 插件 `dsh-paofu-console` 在 `<路径>`，帮我用 npm/软链接装进当前的 DSH profile，
> 然后在 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 里加这个包，
> 并把它加进 `dsh.profile.bundles` 数组。

### 第四步：让 profile 认识它

打开 `<profile目录>\package.json`，改两个地方：

```json
{
  "dependencies": {
    "dsh-paofu-console": "1.0.2"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...其它插件",
        "dsh-paofu-console"
      ]
    }
  }
}
```

### 第五步：重启 DSH

桌面版一般会热加载；没反应就完全退出再开一次。

---

## 验证装好了没

启动 DSH 后，控制台里应该出现：

```
[paofu-console] 数据服务 http://<回环地址>:9896
```

然后访问（端口换成你 DSH 实际用的）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' '<你的 DSH 地址>/dsh-paofu-console/'
```

`200` 就是成了。

---

## 想让它显示真实的 QQ 桥接数据

看包里的 `接上桥接.md`。核心是一句话：**桥接不在就用示例数据，不报错**。

数据服务会读这些位置：

| 面板上的东西 | 读的路径 |
| --- | --- |
| 在线、未读数、谁最近说过话 | `<桥接>/api/status` |
| 会话列表 | `<桥接>/state/social-v2.json` |
| 日记 | `<桥接>/state/diary/*.md` |
| 表情库 | `<桥接>/memes/` |
| 语音 | `<桥接>/audio/` |
| 用量、余额 | `<桥接>/scripts/` 里的四个导出脚本 |

## 环境变量（都可选）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PAFU_BRIDGE` | 自动找（家目录 / 文档 / 当前目录） | 桥接根目录 |
| `PAFU_BRIDGE_PORT` | 桥接的默认口 | 桥接的 HTTP 端口 |
| `PAFU_PORT` | `9896` | 数据服务端口，被占了会复用现成的 |
| `PAFU_CONSOLE` | 包内目录 | 面板数据根目录（下挂 `data/`） |
| `PAFU_TOKEN` | 读 `<BRIDGE>/state/console-token` | 桥接控制台令牌 |

## 自带什么

`data/` 里全是**示例数据**，直接改文本就换成你自己的：

`mood.json`（心情）、`promises.json`（承诺账本）、`skills.json`（技能）、
`novel.md`（小说，支持 Markdown）、`history.json`（时间线）、`memory.json`（记忆导出）。

## 目录

```
lib/index.mjs       宿主：挂路由 + 起数据服务 + 反代
web/index.html      整个前端（单文件，无构建）
data/               面板自己的数据（示例）
cordis.patch.yml    注册一条宿主行
icon.svg            图标
```

## 已知限制

- 两个入口都只绑 `127.0.0.1`，**外网访问不到**（面板没有密码，这是故意的）
- 用量/余额卡片依赖桥接侧导出脚本，纯离线时这两块是空的
- 3D 记忆网络需要浏览器支持 WebGL

## 许可

MIT，见 `LICENSE`。
