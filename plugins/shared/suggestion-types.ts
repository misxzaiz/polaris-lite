/** 开场建议共享类型与分类标签（chat-lite 与 starter-suggestions 两处消费，放 shared 避免插件互引）。 */

export type CategoryId = 'explore' | 'tools' | 'code' | 'write' | 'think' | 'play';

export const CATEGORY_LABEL: Record<CategoryId, string> = {
  explore: '探索发现',
  tools: '工具执行',
  code: '编程',
  write: '写作表达',
  think: '思考决策',
  play: '趣味灵感',
};

export interface Suggestion {
  label: string;
  prompt: string;
  category: CategoryId;
}

/** starter-suggestions 插件 kv 池条目（只取渲染/校验所需字段） */
export interface StarterSuggestion extends Suggestion {
  id: string;
  enabled: boolean;
  source: 'builtin' | 'ai' | 'user';
  createdAt: string;
  uses?: number;
}

export interface SuggestionPool {
  version: 1;
  items: StarterSuggestion[];
}

/** 内置开场建议种子池（starter-suggestions 首次初始化与 chat-lite 兜底共用） */
export const SUGGESTIONS: Suggestion[] = [
  // ---- 探索发现 ----
  {
    label: '今天有什么值得关注的大事',
    prompt: '浏览一下今天的新闻，挑出 3 条最值得关注的，每条用两三句话讲清楚它为什么重要。',
    category: 'explore',
  },
  {
    label: '快速了解一个新概念',
    prompt: '用大白话和一个贴近生活的类比，给我讲清楚「复利效应」是什么、为什么重要，最后用三句话总结。',
    category: 'explore',
  },
  {
    label: '帮我辨别一个流行说法',
    prompt: '关于「每天必须喝满 8 杯水才健康」这个常见说法，帮我查一下依据，区分哪些有科学支持、哪些是流传误区。',
    category: 'explore',
  },
  {
    label: '帮我做一次小调研',
    prompt: '我想了解「个人知识管理工具」的主流选择，帮我对比 3 个代表性工具的优缺点和适用人群，最后按不同场景给出选择建议。',
    category: 'explore',
  },
  {
    label: '帮我把长文读短',
    prompt: '我会贴一篇文章，请把它提炼成 5 条核心要点、1 个最容易被忽略的细节，以及 1 句话总结。',
    category: 'explore',
  },

  // ---- 工具执行 ----
  {
    label: '做一个能点着玩的番茄钟',
    prompt: '给我做一个番茄钟交互面板：支持开始、暂停、重置，默认 25 分钟专注 + 5 分钟休息，界面简洁好看，带进度显示。',
    category: 'tools',
  },
  {
    label: '记一笔，顺便看看开销',
    prompt: '帮我记一笔：今天午饭花了 35 元。然后统计一下这个月的总支出和主要花销类别。',
    category: 'tools',
  },
  {
    label: '把想法拆成计划',
    prompt: '我想在一个月内养成每天阅读 30 分钟的习惯。帮我把这个目标拆成周计划、每天的最低行动，以及应对中断的补救策略。',
    category: 'tools',
  },
  {
    label: '整理一堆零散信息',
    prompt: '我手头有几段零散的会议记录（我接下来会贴出），请帮我整理成结构化要点：已达成、待办、风险、需要跟进的人。',
    category: 'tools',
  },
  {
    label: '写个自动化小脚本',
    prompt: '用 Python 写一个小脚本：扫描指定文件夹里的重复文件（按内容哈希），列出可安全删除的副本，并解释每一步在做什么。',
    category: 'tools',
  },

  // ---- 编程 ----
  {
    label: '读懂一段代码',
    prompt: '我会贴一段代码，请逐块解释它在做什么、为什么这么写，指出潜在问题，最后用一句话概括整体逻辑。',
    category: 'code',
  },
  {
    label: '构建一个 SQL 查询',
    prompt: '假设有一张订单表 orders(id, user_id, amount, created_at)，帮我写一个查询：统计每个月的订单数和总金额，只保留总金额超过 10000 的月份，并解释每一步。',
    category: 'code',
  },
  {
    label: '诊断一个报错',
    prompt: '我会贴出报错信息和相关代码，请帮我定位根本原因，给出最小修复方案，并说明如何避免再次出现。',
    category: 'code',
  },
  {
    label: '优化一段能跑的代码',
    prompt: '我会贴一段能正常工作的代码，请从可读性、边界情况、性能三个角度给改进建议，并给出重构后的版本。',
    category: 'code',
  },
  {
    label: '设计一个小功能',
    prompt: '我想给一个待办事项应用加「优先级排序」功能。帮我设计数据结构、交互流程和边界情况处理，并给出核心代码实现。',
    category: 'code',
  },

  // ---- 写作表达 ----
  {
    label: '写封不好开口的邮件',
    prompt: '我想婉拒一个关系不错的同事邀我参加的周末聚会，不想伤感情。帮我写一封简短得体的中文邮件，语气自然不生硬。',
    category: 'write',
  },
  {
    label: '一句话变成好文案',
    prompt: '把「我们的产品很快」改写成三个版本：朋友圈文案、产品官网文案、正式商务介绍，每版不超过两句话。',
    category: 'write',
  },
  {
    label: '改写简历里的一段经历',
    prompt: '这段简历经历是「负责公司公众号运营，涨了粉丝」。请帮我改得更具体、更有结果感，突出方法论和数据，并提供两个版本。',
    category: 'write',
  },
  {
    label: '把报告压缩成一页纸',
    prompt: '我会贴一份报告，请提炼成一页纸摘要：核心结论、关键数据、主要风险、下一步建议。',
    category: 'write',
  },
  {
    label: '给我的项目起十个名字',
    prompt: '我在做一个帮助用户记录和回顾梦境的小应用，给我起 10 个名字：3 个正经、4 个有记忆点、3 个离谱但好玩，每个名字配一句话理由。',
    category: 'write',
  },

  // ---- 思考决策 ----
  {
    label: '陪我推演一个决定',
    prompt: '我在纠结是否要换工作：现在稳定但成长慢，新机会有吸引力但不确定性高。帮我列利弊、推演最坏结果，并给出一个分阶段的验证计划。',
    category: 'think',
  },
  {
    label: '当我的魔鬼代言人',
    prompt: '我的观点是「远程办公比坐班效率更高」。请站在反方，用最强、最具体的论据反驳我，最后告诉我哪些反驳最值得我警惕。',
    category: 'think',
  },
  {
    label: '识别我的思维偏差',
    prompt: '我最近总觉得「别人都比我顺利」。帮我分析这种感受背后可能的认知偏差，并给出三个可操作的纠正方法。',
    category: 'think',
  },
  {
    label: '把大目标拆到今天',
    prompt: '我的目标是三个月内通过一个专业考试。帮我把目标拆成本周的三件关键事，以及今天 30 分钟内就能完成的起步动作。',
    category: 'think',
  },
  {
    label: '帮我复盘一次沟通',
    prompt: '我会描述一次我搞砸的沟通经过，请帮我复盘：哪里出了问题、当时更好的做法、以后遇到类似场景怎么提前准备。',
    category: 'think',
  },

  // ---- 趣味灵感 ----
  {
    label: '三句话反转故事',
    prompt: '用三句话写一个科幻微小说：一个看似日常的场景，结尾必须反转。写完再揭晓你埋下的伏笔。',
    category: 'play',
  },
  {
    label: '用破案口吻讲知识',
    prompt: '用侦探破案的口吻解释「为什么天空是蓝色的」：把光线和散射写成案件调查，最后给出结案陈词。',
    category: 'play',
  },
  {
    label: '出一道烧脑谜题',
    prompt: '出一道适合成年人的逻辑谜题，难度中上。我先猜答案，你只回复「对」「不对」或「接近了」，直到我猜中为止。',
    category: 'play',
  },
  {
    label: '设计一个生活小实验',
    prompt: '帮我设计一个一周内能完成的「生活小实验」，用来验证某个习惯是否让我更高效，包括假设、做法、记录方式和判断标准。',
    category: 'play',
  },
  {
    label: '写一首关于今天的诗',
    prompt: '以「一个普通工作日的下午」为主题，写一首不超过 12 行的现代诗，意象要具体，不要陈词滥调。',
    category: 'play',
  },
];
