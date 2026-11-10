# 海弘售前协同系统｜外网部署交接

更新日期：2026-11-10。适用于公司指定的 Linux 主机，使用 Node.js、SQLite、systemd 和 Nginx 单实例部署。

## 1. 交付范围与服务器信息

| 项目 | 首发配置 |
|---|---|
| 入口 | 公司域名的 HTTPS 地址，Nginx 转发至 `127.0.0.1:4173` |
| 功能 | `CORE`。客户管理、报价管理，以及管理员的账号、客户字典和备份状态 |
| 正式数据 | `PRODUCTION`。独立的空数据库、附件目录与备份目录 |
| 登录 | 管理员发放独立账号。密码在终端隐式输入或由管理员设置，重置后用户首次登录改密 |
| 报价 | 从服务器下载公司标准 Word 模板，在本地填写并转为 PDF。上传 PDF 后可在页面预览，按三级审批和版本留痕 |

研发部经理、综合部经理和副总经理均可查看全公司的客户主档、联系人、报价及历史版本。售前只能查看自己当前负责的客户和报价。研发部经理只处理分给自己的一级审核，综合部经理处理二级审核，副总经理处理终审。经理已有的客户代录、日期补录和转让操作按原直属范围执行。审批备注在表格中保留一行，悬停或轻触可看全文。

正式上线前由运维确认部署主机、域名和证书、可访问人员、备份保留周期、异地副本位置和故障联络人。部署时使用交付的 Git 提交号，以便核对运行版本。生产数据在服务器中建立，测试数据库和客户附件由测试环境单独归档。

## 2. 首次安装

以下命令面向使用 systemd 的 Linux 主机。以具备 `sudo` 权限的运维账号操作。先安装 Git、Nginx、Node.js 22.13.0 或以上和 npm。若 SQLite 依赖安装时需要本机编译，按发行版安装 Python 3、make 和 C/C++ 工具链。

### 2.1 检出交付版本与安装依赖

替换仓库、分支与交付提交号。私有仓库通过已获授权的 GitHub 账号或运维凭据克隆。凭据由 Git 的凭据工具保管。

~~~bash
repo_url='https://github.com/OWNER/REPOSITORY.git'
delivery_branch='DELIVERY_BRANCH'
expected_commit='FULL_DELIVERY_COMMIT_SHA'
stage_dir="$(mktemp -d)"

git clone --branch "$delivery_branch" --single-branch "$repo_url" "$stage_dir/source"
git -C "$stage_dir/source" checkout --detach "$expected_commit"
git -C "$stage_dir/source" rev-parse HEAD
node --version
npm --version
command -v node

cd "$stage_dir/source"
npm ci --omit=dev
~~~

在验收环境先运行 `npm ci` 和 `npm test`。在目标主机安装依赖，使 SQLite 的本机模块与服务器的操作系统、CPU 和 Node.js 版本一致。systemd 模板默认使用 `/usr/bin/node`。如果实际路径不同，统一替换下文命令和服务文件中的 Node.js 路径。

### 2.2 创建运行账号和生产目录

~~~bash
id haihong-presales >/dev/null 2>&1 ||
  sudo useradd --system --user-group --home-dir /var/lib/haihong-presales --shell /usr/sbin/nologin haihong-presales

sudo install -d -o root -g haihong-presales -m 0750 \
  /opt/haihong-presales-hub /opt/haihong-presales-hub/releases
sudo install -d -o haihong-presales -g haihong-presales -m 0750 \
  /var/lib/haihong-presales /var/lib/haihong-presales/storage \
  /var/backups/haihong-presales /var/lib/haihong-presales-drills
sudo install -d -o root -g haihong-presales -m 0750 /etc/haihong-presales-hub

release_id="$(git rev-parse --short=12 HEAD)"
release_dir="/opt/haihong-presales-hub/releases/$release_id"
sudo install -d -o root -g haihong-presales -m 0750 "$release_dir"
git archive HEAD | sudo tar -x -C "$release_dir"
sudo cp -a node_modules "$release_dir/node_modules"
sudo chown -R root:haihong-presales "$release_dir"
sudo ln -s "$release_dir" /opt/haihong-presales-hub/current
~~~

最后一行用于首次安装。已有 `current` 的主机按第 6 节切换。SQLite 数据库及其 WAL 文件使用本机持久磁盘，应用只运行一个实例。数据库、附件和备份都位于代码目录之外。

### 2.3 写入正式配置

~~~bash
sudo install -o root -g root -m 0600 \
  "$release_dir/deploy/env.production.example" /etc/haihong-presales-hub/haihong.env
sudoedit /etc/haihong-presales-hub/haihong.env
~~~

公司现用 Word 模板含正式收款信息，由业务负责人通过内部渠道提供。取得文件后按下面的路径安装，应用以原字节提供下载。

~~~bash
company_template='/secure/handoff/quote-standard-template.docx'
sudo install -o root -g haihong-presales -m 0640 "$company_template" \
  /etc/haihong-presales-hub/quote-standard-template.docx
sudo -u haihong-presales test -r /etc/haihong-presales-hub/quote-standard-template.docx
~~~

| 环境变量 | 正式配置或说明 |
|---|---|
| `HH_HOST` / `HH_PORT` | `127.0.0.1` / `4173`，仅由本机代理转发 |
| `HH_LAUNCH_PROFILE` / `HH_DATA_MODE` | `CORE` / `PRODUCTION` |
| `HH_DATABASE_PATH` | `/var/lib/haihong-presales/presales-hub.db` |
| `HH_STORAGE_PATH` | `/var/lib/haihong-presales/storage` |
| `HH_QUOTE_STANDARD_TEMPLATE_PATH` | `/etc/haihong-presales-hub/quote-standard-template.docx` |
| `HH_BACKUP_PATH` | `/var/backups/haihong-presales` |
| `HH_SECURE_COOKIE` / `HH_TRUST_PROXY` | `true` / `loopback`，适用于同机 Nginx |
| `HH_SESSION_HOURS` | 默认 8 小时 |
| `HH_BACKUP_HOUR` / `TZ` | 默认每天 02:00，按 `Asia/Shanghai` 执行 |

已有正式配置的升级只核对参数和路径。当前发布版本不需要填写初始密码、Token 或私钥。证书私钥留在运维证书目录。

### 2.4 初始化管理员并安装服务

首次使用全新生产数据库时执行下列命令。设置系统管理员用户名并在终端输入两次强密码。

~~~bash
sudo systemd-run --wait --pty --collect \
  -p User=haihong-presales -p Group=haihong-presales \
  -p WorkingDirectory=/opt/haihong-presales-hub/current \
  -p EnvironmentFile=/etc/haihong-presales-hub/haihong.env \
  /usr/bin/node scripts/init-admin.js --username admin --display-name "系统管理员"

sudo install -m 0644 "$release_dir/deploy/linux/haihong-presales-hub.service.example" \
  /etc/systemd/system/haihong-presales-hub.service
sudo systemctl daemon-reload
sudo systemctl enable --now haihong-presales-hub
sudo systemctl status haihong-presales-hub --no-pager
curl -fsS http://127.0.0.1:4173/api/health
~~~

如需核对运行日志，使用 `sudo journalctl -u haihong-presales-hub -n 100 --no-pager`。

### 2.5 接入 HTTPS

~~~bash
sudo install -m 0644 "$release_dir/deploy/nginx/presales-hub.conf.example" \
  /etc/nginx/conf.d/haihong-presales-hub.conf
sudoedit /etc/nginx/conf.d/haihong-presales-hub.conf
sudo nginx -t
sudo systemctl reload nginx
~~~

将模板域名替换为正式域名，并更新证书和私钥路径。部署前配置好 DNS。公网入口为 443，80 用于 HTTPS 跳转。4173 只监听回环地址，远程管理使用公司允许的来源或 VPN。沿用模板中的登录限流和上传体积配置。Nginx 只代理应用请求，数据目录由应用按会话权限访问。

## 3. 开通账号

1. 通过正式 HTTPS 地址登录系统管理员账号，进入“系统管理”。
2. 创建综合部经理、研发部经理和副总经理账号。“创建用户”表单中的“研发经理”对应研发部经理。售前直属综合部经理时，应保持一名启用的研发部经理，以便系统为一级审批分配审核人。
3. 创建售前账号，逐个关联直属综合部经理。管理员通过公司约定的安全渠道交付初始凭据。
4. 使用各角色分别完成一次登录和权限验收。正式客户和报价数据从验收通过后开始录入。

## 4. 验收步骤

~~~bash
domain='presales.example.com'
curl -fsS "https://$domain/api/health"
curl -fsS "https://$domain/api/runtime"
curl -s -o /dev/null -w '%{http_code}\n' "https://$domain/api/auth/session"
~~~

健康接口应返回 `"ok":true`。运行配置应返回 `CORE` 和 `PRODUCTION`。未登录访问会话接口应返回 `401`。

| 验收人 | 操作与预期 |
|---|---|
| 运维 | HTTPS 证书有效，登录 Cookie 带 `Secure`。服务器监听为 `127.0.0.1:4173`，服务日志可读 |
| 两名售前 | 分别使用虚构客户在验收环境登记。新客户自动归本人，彼此无法打开对方客户或报价 |
| 三类领导 | 都能打开客户与报价管理，读到跨团队客户及其报价 PDF。只有到达本人审批环节的报价出现在“待我审批” |
| 售前与审核人 | 下载标准 Word 模板，上传合规 PDF 并预览。依次验证一级、二级和终审。退回时保留旧 PDF 和审批意见，重发形成独立版本 |
| 审核人 | 悬停长备注可读全文，审批记录各列保持原位。手机端轻触可查看 |
| 管理员 | 重置验收账号密码后，旧会话失效。新密码登录后按提示修改密码 |
| 运维 | 执行一次手工备份和隔离恢复，核对数据库、附件和清单 |

用独立的验收库执行会写数据的流程。首次切到正式空库时核对客户、报价和业务附件均为空，并确认管理员及指定账号可以登录。

## 5. 备份与隔离恢复

手工备份使用与服务相同的生产配置和运行账号。升级前记录备份批次号。每日备份可在“系统管理”核对最近完成时间和状态。

~~~bash
sudo systemd-run --wait --pipe --collect \
  -p User=haihong-presales -p Group=haihong-presales \
  -p WorkingDirectory=/opt/haihong-presales-hub/current \
  -p EnvironmentFile=/etc/haihong-presales-hub/haihong.env \
  /usr/bin/node scripts/backup.js --reason "发布前备份"
~~~

按实际批次名填写路径。每次演练使用一个全新目录，目录在正式数据库目录、附件目录和备份目录之外。

~~~bash
batch_dir='/var/backups/haihong-presales/ACTUAL_BACKUP_BATCH'
drill_dir="/var/lib/haihong-presales-drills/drill-$(date +%Y%m%d-%H%M%S)"

sudo systemd-run --wait --pipe --collect \
  -p User=haihong-presales -p Group=haihong-presales \
  -p WorkingDirectory=/opt/haihong-presales-hub/current \
  -p EnvironmentFile=/etc/haihong-presales-hub/haihong.env \
  /usr/bin/node scripts/restore-backup.js --batch "$batch_dir" --target "$drill_dir"
~~~

成功时控制台显示数据库校验通过、已校验附件数量。备份清单记录文件 SHA-256 和外键检查。正式配置和标准报价模板作为受限运维资料单独备份。运维按公司要求同步一份备份至异地存储，记录恢复时间和抽查结果。

## 6. 更新与回退

- 用第 2.1 节命令检出目标提交并安装依赖。按第 2.2 节复制到新的版本目录，保留原 `current` 链接、生产配置和旧版本。
- 约定停机窗口，执行 `sudo systemctl stop haihong-presales-hub`，然后用旧版本和正式配置做一次备份。核对批次成功后切换应用目录。
- 在变量 `release_dir` 指向已验收版本时，执行以下命令。重新执行健康检查、角色读写验证和 PDF 预览。

~~~bash
readlink -f /opt/haihong-presales-hub/current
sudo ln -s "$release_dir" /opt/haihong-presales-hub/current.next
sudo mv -Tf /opt/haihong-presales-hub/current.next /opt/haihong-presales-hub/current
sudo systemctl start haihong-presales-hub
~~~

如果只有应用问题且旧版与当前库兼容，可停服后把 `release_dir` 改为上一个版本，按相同方式切回。如果升级影响库结构或附件，先按第 5 节恢复到独立目录，核对数据库和附件，再由运维安排正式切换。正式数据库文件和恢复副本分别保留。

## 7. 常见问题

| 现象 | 检查 |
|---|---|
| Nginx 返回 502 | 检查 systemd 状态、应用监听地址、Node.js 路径及启动日志 |
| 登录后反复回到登录页 | 使用正式 HTTPS 域名，核对 Cookie 的 `Secure` 属性和代理传递的协议 |
| 上传返回 413 | 核对 Nginx 上传限制及应用的 20 MB 单个 PDF 上限 |
| 标准报价模板不可用 | 核对 `HH_QUOTE_STANDARD_TEMPLATE_PATH`、已安装的 DOCX 和运行账号的读权限 |
| 报价卡在一级审核 | 核对售前直属综合部经理及启用的研发部经理配置 |
| 某个报价提示金额未核对 | PDF 总额未被可靠识别。审核人对照原件，系统记录该提示 |
| 备份状态异常 | 查看最近成功批次及运行日志，完成一次手工备份和隔离恢复 |

首发所需 PDF 预览由项目内置组件提供。额外文档服务适用于后续需要增强 Word 或 Excel 原版式预览的场景。
