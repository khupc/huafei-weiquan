# 话费维权指引 MVP

按《话费维权服务路链 v1.2》实现，并按第一轮测试反馈调整：5 节点状态机 + 法条库 + 隐私脱敏 + 后置护栏 + 移动端 H5。
节点一由模型理解事实、从法条库挑适用条款、给出诉求可行性，**诉求由用户自己选**；S1-S7 只作统计标签。
默认用**关键词 stub**，不接大模型也能走通；接真模型见下文。

> ⚠️ `backend/app/rules/*.yaml` 里的法条库（`laws.yaml`，原文待补）、客服热线、转人工口令、企业全称模板、谈判底线均照搬 v1.2 文档，
> 标记为 `legal_review: pending`。**上线前必须由法务/律师逐条审校**；话术为初稿，需产品确认措辞。

## 本地运行

需要 Python 3.11+、PostgreSQL 14+。

```bash
createdb huafei   # 或自行建库，连接串用 DATABASE_URL 指定
cd backend
pip install -r requirements.txt
export DATABASE_URL=postgresql+psycopg://用户:密码@localhost:5432/huafei
uvicorn app.main:app --port 8000
```

手机浏览器或电脑浏览器打开 http://localhost:8000/ 即可体验（启动时自动建表）。

测试（需要一个空的测试库）：

```bash
DATABASE_URL=postgresql+psycopg://用户:密码@localhost:5432/huafei_test python -m pytest -q
```

## 目录

```
backend/app/
  main.py         接口路由（FastAPI），同时托管前端页面
  fsm.py          5 节点状态机、确认卡、T0+3 天提醒 / T0+15 天自动升级扫描、数据回流
  render.py       各节点卡片的确定性拼装（法条/热线/底线一律来自规则库）
  privacy.py      脱敏中间件：手机号、身份证号（含校验位）、“我叫XX”类姓名 → 占位符
  guardrails.py   后置护栏：剔除模型编造的法条与赔偿倍数、去情绪词、补回工单号/工号/金额、280 字截断
  models.py       4 张表：cases / case_event_logs / sft_feedback_samples / case_closing_surveys
  llm/base.py     模型契约（任务 A 槽位提取、任务 B 追问、总结、任务 C 改写、截图解析）
  llm/stub.py     关键词版实现，仅供演示与测试
  llm/openai_compat.py  OpenAI 兼容接口的真模型实现（Hugging Face / 百炼 / 智谱）
  rules/          carriers.yaml（运营商）、laws.yaml（法条库）、categories.yaml（S1-S7 统计标签）、templates.yaml（各节点文案）
frontend/         单页 H5（Vue3，已内置，无需构建）
```

## 状态流转

`NODE_1_INTAKE` → `NODE_1_CONFIRM_CARD` → `NODE_1_ADVICE`（看法条依据和诉求可行性，用户选诉求）
→（无工单）`NODE_2_CALL` / （有工单）`NODE_3_APPEAL`
→ `NODE_4_CALLBACK`（写入 T0）→ `NODE_5_ESCALATE`（协商破裂或 T0+15 天）→ `CLOSED`。
节点二/三和建议页都能回到确认卡，确认后按新事实重新分析。任一节点都可“不想弄了”填问卷结案。

## 本版做的取舍（需要产品确认）

- **省份 + 城市**：12300 申诉表单的“所属地区”要选到地级市，确认卡上必填；城市是文本输入。
- **节点三**：照微信小程序“工信部12300”的申诉表单逐项给出怎么填，申诉内容一段复制（25 到 500 字）；不再拼“申诉企业全称”。
- **法条库**：模型只能按 id 引用 `laws.yaml` 里的条款，页面显示的名称/原文都取自库；条款原文为空、标“待审”，需法务补齐。
- **用户期望**：核心事实问清后追问一次“希望怎么解决”，不阻塞流程；它排在诉求选项第一位并作为节点四的底线。
- **T0+3 天**：文档只写了定时任务，没写要做什么。目前只给案件打标记，H5 节点四显示“已经 3 天了，专员联系你了吗”提示；没有推送渠道（小程序订阅消息等需另接）。
- **Redis**：MVP 没用。超时扫描直接走 `(current_state, t0_submitted_at)` 索引，应用内每小时跑一次（`JOB_INTERVAL_SECONDS` 可调，多实例部署时设 `RUN_SCHEDULER=0` 只留一个实例跑）。
- **截图**：图片本身不落库（可能含手机号），只存解析出的字段；stub 不能识图，需要接多模态模型。
- **节点二回填**：客服工号/工单号/通话日期均为选填（客服拒报工号时用户仍能继续）。

## 已知限制

- stub 只做关键词匹配：分类、总结、改写都很粗糙，总结里会直接出现 `<PHONE_MASKED>` 这类占位符。真实模型接入后由提示词约束。
- 姓名脱敏只识别“我叫 / 我是 / 姓名：”后面的 2-3 个汉字，没有 NER。
- 用户号码若恰好以工单号字段填入，不会被脱敏（工单号/工号字段刻意豁免，避免护栏补全时丢失）。

## 接入真实模型

任何 OpenAI 兼容接口都可以，设环境变量即可：

```bash
export LLM_PROVIDER=openai
export HF_TOKEN=...                      # 或 LLM_API_KEY
export LLM_BASE_URL=https://router.huggingface.co/v1   # 默认值；百炼/智谱换成各自的地址
export LLM_MODEL=Qwen/Qwen2.5-72B-Instruct             # 默认值
```

某次调用失败或返回的不是合法 JSON 时，这一次自动退回关键词版，流程不会卡住。追问话术固定用 `templates.yaml` 里的文案。
国内用户访问 Hugging Face 不稳定，只建议测试阶段使用。
