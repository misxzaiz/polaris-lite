/** Personal Hub 数据类型（对齐 Polaris src/services/personalHub/types.ts） */

export interface User {
  id: string;
  email: string;
}

/** links 表 type 联合类型 */
export type LinkType = 'navigation' | 'bookmark' | 'todo' | 'note';

export interface Link {
  id: string;
  user_id: string;
  title: string;
  url?: string | null;
  description?: string | null;
  type: LinkType;
  tags?: string[] | null;
  completed?: boolean | null;
  priority?: 'low' | 'medium' | 'high' | null;
  due_date?: string | null;
  is_encrypted?: boolean | null;
  icon?: string | null;
  created_at: string;
  updated_at: string;
}

export type Priority = 'low' | 'medium' | 'high';
export type StatusFilter = 'all' | 'pending' | 'completed';
export type DueDateFilter = 'all' | 'today' | 'week' | 'month' | 'overdue';
export type SortField = 'created_at' | 'updated_at' | 'title' | 'priority' | 'due_date';
export type SortOrder = 'asc' | 'desc';

/** 创建/更新用的载荷（部分字段） */
export type LinkInput = Partial<Omit<Link, 'id' | 'user_id' | 'created_at' | 'updated_at'>>;

/** personal-hub 配置（Supabase 连接 + 可选字段加密密钥） */
export interface PersonalHubConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  encryptionKey: string;
}
