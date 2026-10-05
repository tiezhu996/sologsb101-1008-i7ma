# 供热管网水力平衡调节台（sologsb101-1008）

面向供热公司运行调度与二次网平衡调节班组，按换热站—楼栋—单元三级登记阀门开度与设计流量，用实测流量与室温反馈计算失衡度并下发调节单。核心动作：建站与楼栋、登记阀位与设计参数、录入实测流量与供回水温、算失衡度排序、下发调节单并复核。

> 纯前端单页应用（SPA）：**无后端 / 无数据库服务 / 无 API**，全部数据保存在浏览器本地 IndexedDB。

## 一、Docker 一键启动（推荐）

在项目根目录（本 README 所在目录）执行：

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22808**

常用运维命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并删除容器
docker compose up -d --build      # 改代码后重新构建启动
```

如需更换宿主端口，修改 `.env` 中的 `FRONTEND_PORT` 后重新 `docker compose up -d`。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5 | `<script setup>` + Composition API |
| 语言 | TypeScript 5.7 | `strict` 严格模式，构建前执行 `vue-tsc --noEmit` |
| UI 组件 | TDesign Vue Next 1.20 | 表格、表单、Dialog、Tag、Descriptions、Progress |
| 状态管理 | Pinia 2.3 | `stationStore` / `valveStore` / `adjustStore` |
| 路由 | Vue Router 4.5 | History 模式，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种 |
| 构建 | Vite 6 | 输出 `dist/`，按路由自动分包 |
| 运行 | nginx:alpine | 静态托管 + gzip + SPA 回退 |

## 三、目录结构

```
sologsb101-1008/
├── README.md
├── docker-compose.yml          # 不写 version；顶层 name: gbheatgrid
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/              # station.ts building.ts valve.ts measure.ts adjust.ts
        ├── stores/             # stationStore.ts valveStore.ts adjustStore.ts
        ├── components/common/  # BalanceTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useImbalanceRank.ts useIdbTable.ts
        ├── pages/              # StationList.vue ValveList.vue MeasureEntry.vue BalanceBoard.vue AdjustOrder.vue
        ├── router/index.ts
        ├── utils/              # balance.ts db.ts export.ts
        ├── styles/main.css
        ├── App.vue
        └── main.ts
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 换热站与楼栋台账 | Station、Building | 新建/编辑/删除换热站与楼栋；按供热方式与面积区间筛选；卡片回显失衡楼栋数与待复核单数 |
| `/valves` | 阀位与设计参数登记 | Valve、Building | 登记口径/位置/开度/设计流量；开度改动进入草稿后可逐条或批量提交；失衡标签与开度校核 |
| `/measures` | 实测流量/供回水温录入 | Measure、Valve | 按日期成组录入流量与三温；支持「阀门编号,日期,流量,供温,回温,室温,录入人」批量粘贴导入并即时预览失衡度 |
| `/balance` | 失衡度计算与排序 | Valve、Measure | 按失衡度降序排行；仅看失衡；导出失衡度 CSV；单条/一键生成调节单 |
| `/adjusts` | 调节单下发与复核 | Adjust、Valve、Measure | 派单即冻结依据快照（当时最新实测+开度），补录/改实测不改原依据；整批执行在事务内冻结当时实测与执行前开度并回写目标开度，中途失败整体回滚、恢复本批阀门开度，未完成单据留在待下发可重试；复核只认执行后新采集数据；旧依据实测被修改/删除则单据退回「待复测」并说明原因，原复核结论在留痕中可查；导出调节单 CSV 与全量 JSON |

## 五、数据存储说明

- **IndexedDB 库名**：`gbheatgrid`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`stations`、`buildings`、`valves`、`measures`、`adjusts`
- **数据结构版本**：`DB_VERSION = 3`，含 `version(1)` → `version(2)` → `version(3)` 的索引变更与 `upgrade()` 迁移。v3 为调节单补齐派单/执行/复核冻结快照（`basisSnapshot`、`beforeOpening`、`executedAt`、`reviewSnapshot`、`reviewHistory`、`invalidReason` 等），并把已执行/已复核单据按当时最新实测回填快照
- **实测与调节单分离**：实测记录独立保存，调节单只持有派单/执行/复核时点的结构化快照；之后补录或修改实测不会改变原签字依据
- **首屏自动播种**：`initDatabase()` 中 `if (await db.stations.count() === 0) await seedDatabase()`，播种 2 座换热站 → 5 栋楼 → 10 只阀门 → 21 条实测 → 5 张调节单（含待下发/已调节/已复核/待复测四种状态）的互相引用数据；播种幂等
- **localStorage 辅助键**：`gbheatgrid:db-version`、`gbheatgrid:last-backup-at`、`gbheatgrid:ui-prefs`（上次选中换热站、仅看失衡开关）
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22808
npm run build      # vue-tsc --noEmit && vite build（类型检查 + 生产构建）
npm run verify     # 冻结/复核门控/失效回退/整批回滚逻辑校验（tsx + fake-indexeddb）
npm run preview    # 本地预览构建产物
```

## 七、判定口径

- 流量比 `= 实测流量 ÷ 设计流量`；流量偏差率 `= (流量比 − 1) × 100%`
- 室温偏差 `= 室温 − 20℃`
- 合成失衡度 `= |流量偏差率| × 0.7 + |室温偏差| × 1.5`（单位 %）
- 判级：`≤ 10%` 平衡，`10% ~ 25%` 偏大 / 偏小（按流量方向），`> 25%` 严重失衡
- 目标开度建议 `= 当前开度 ÷ 流量比`，按 5% 取整并限制在 20% ~ 100%

## 八、冻结、复核与失效口径

- **派单冻结**：生成调节单时把当时最新实测（日期、流量、三温、流量比、失衡度、判级）与阀门开度固化进 `basisSnapshot`，后续在实测页补录或修改记录，调节单上的原签字依据保持不变
- **执行冻结**：执行（单张或整批）时再以当时最新实测重冻依据，并记录执行前开度 `beforeOpening`、执行时间 `executedAt`，再把目标开度回写到阀门台账
- **复核口径**：复核只采信执行时间之后新采集的实测（日期晚于执行日，或同日且录入时间晚于执行时刻）；没有执行后新数据时不允许闭环
- **旧记录改动失效**：被冻结引用（派单依据/复核实测）的旧实测被修改或删除，已调节/已复核的单据退回「待复测」并写明原因，阀门开度保持执行结果；原复核意见与历次快照保存在 `reviewHistory` 中仍可查看，用执行后新数据复核后重新闭环
- **整批执行一致性**：全部阀门开度回写与单据状态推进在同一个 Dexie 事务内完成，任一条写入失败整体回滚（本批阀门开度恢复执行前），失败时事务外再做一次开度补偿恢复；未完成单据留在「待下发」，可直接重试
- **统一结果口径**：`useImbalanceRank()` 为全应用单例，失衡排行、调节单「执行后新采集」列、站内汇总失衡统计均消费同一实例，不再各算一份；调节单 CSV 同样按冻结依据 + 执行后新数据导出
