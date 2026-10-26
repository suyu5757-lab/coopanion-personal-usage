/**
 * What the browser tools refuse regardless of what Coo asks for: spending, private messages, and
 * typing credentials or personal contact details. The lists are phrases, not single characters, so a
 * video titled around one of the words is still openable. The model is told the same rules in the
 * World's environment prompt; this guard is the mechanical backstop for the ones that cost money.
 */
export type ClickRefusal = 'payment' | 'private' | 'account';
export type TypeRefusal = 'personal';

const PAYMENT = [
  '购买', '购买并', '立即购买', '买下', '买它', '下单', '提交订单', '结算', '支付', '付款', '确认支付', '免密', '充值', '续费',
  '开通会员', '开通大', '大会员', '会员购', '打赏', '投币', '一键三连', '送礼物', '送礼', '捐赠', '赞助', '提现', '转账',
  '红包', '银行卡', '钱包', '商城', '购物车', '抢购', '支付密码',
  'pay now', 'buy now', 'purchase', 'checkout', 'place order', 'confirm payment', 'add to cart', 'top up', 'recharge',
  'donate', 'tip', 'withdraw', 'transfer money',
];

const PRIVATE = [
  '私信', '发消息', '发送消息', '联系卖家',
  'send message', 'private message', 'direct message',
];

const ACCOUNT = [
  '退出登录', '注销账号', '注销帐号', '删除账号', '删除帐号', '解绑', '修改密码', '更换手机号',
  '获取验证码', '发送验证码', '获取短信', '重新发送',
  'sign out', 'log out', 'delete account', 'change password', 'send code', 'resend code',
];

const WRITE_ACTIONS = [
  '点赞', '收藏', '关注', '订阅合集', '发布', '发送', '弹幕', '转发',
  'like', 'favorite', 'follow', 'post', 'send', 'danmaku', 'repost',
];

const PERSONAL = [
  '密码', '验证码', '手机号', '手机号码', '邮箱', '账号', '帐号', '银行卡', '身份证', '支付密码',
  'password', 'verification code', 'one-time code', 'phone number', 'email address', 'account', 'card number',
];

const NORMAL = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** A click on this label would spend money or open a private conversation. */
export function clickRefusal(label: string): ClickRefusal | null {
  const text = NORMAL(label);
  if (PAYMENT.some((word) => text.includes(word))) return 'payment';
  if (PRIVATE.some((word) => text.includes(word))) return 'private';
  if (ACCOUNT.some((word) => text.includes(word))) return 'account';
  return null;
}

/** A form field that asks for a password or personal contact details. */
export function typeRefusal(element: { type?: string; label?: string; placeholder?: string; aria?: string; title?: string }): TypeRefusal | null {
  const type = NORMAL(element.type);
  const text = NORMAL([element.type, element.label, element.placeholder, element.aria, element.title].filter(Boolean).join(' '));
  if (type === 'password' || type === 'tel' || type === 'email') return 'personal';
  if (PERSONAL.some((word) => text.includes(word))) return 'personal';
  return null;
}

/** A click that writes to the site rather than moving around it. */
export function isWriteAction(label: string): boolean {
  const text = NORMAL(label);
  return WRITE_ACTIONS.some((word) => text.includes(word));
}

/** Search and find boxes stay usable while the rest of the browser is read-only. */
export function isSearchField(element: { type?: string; label?: string; placeholder?: string; aria?: string; title?: string }): boolean {
  const type = NORMAL(element.type);
  if (type === 'search') return true;
  const text = NORMAL([element.label, element.placeholder, element.aria, element.title].filter(Boolean).join(' '));
  return /搜索|搜一下|查找|search|find/.test(text);
}
