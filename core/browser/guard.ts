/**
 * What the browser tools refuse regardless of what Coo asks for: spending, private messages, and
 * typing credentials or personal contact details. The lists are phrases, not single characters, so a
 * video titled around one of the words is still openable. The model is told the same rules in the
 * World's environment prompt; this guard is the mechanical backstop for the ones that cost money.
 */
export type ClickRefusal = 'payment' | 'private' | 'account' | 'destructive';
export type TypeRefusal = 'personal';

const PAYMENT_ZH = [
  '购买', '购买并', '立即购买', '买下', '买它', '下单', '提交订单', '结算', '支付', '付款', '确认支付', '免密', '充值', '续费',
  '开通会员', '开通大', '大会员', '会员购', '打赏', '投币', '一键三连', '送礼物', '送礼', '捐赠', '赞助', '提现', '转账',
  '红包', '银行卡', '钱包', '商城', '购物车', '抢购', '支付密码',
];
const PAYMENT_EN = /\b(?:pay now|buy now|purchase|checkout|place order|confirm payment|add to cart|top up|recharge|donate|tip|withdraw|transfer money)\b/;

const PRIVATE = [
  '私信', '发消息', '发送消息', '联系卖家',
  'send message', 'private message', 'direct message',
];

const ACCOUNT = [
  '退出登录', '注销账号', '注销帐号', '删除账号', '删除帐号', '解绑', '修改密码', '更换手机号',
  '获取验证码', '发送验证码', '获取短信', '重新发送',
  'sign out', 'log out', 'delete account', 'change password', 'send code', 'resend code',
];

const DESTRUCTIVE_CONTROL = /^(?:删除|移除)(?:(?:这条|此条)?(?:评论|回复|作品|视频|草稿|内容|图片))?\s*$|^(?:delete|remove)(?:\s+(?:this\s+)?(?:comment|reply|post|video|draft|content|image))?\s*$/i;

const WRITE_ACTIONS_ZH = [
  '点赞', '收藏', '关注', '订阅合集', '发布', '发表', '投稿', '提交', '发送', '弹幕', '转发', '分享', '删除', '移除',
];
const WRITE_ACTION_EN = /\b(?:like|likes|liked|liking|favorite|favorites|favorited|favourite|favourites|favourited|follow|follows|followed|post|posts|posted|posting|send|sends|sent|sending|publish|publishes|published|publishing|submit|submits|submitted|submitting|danmaku|repost|reposts|reposted|reposting|share|shares|shared|sharing|delete|deletes|deleted|deleting|remove|removes|removed|removing)\b/;

const PERSONAL = [
  '密码', '验证码', '手机号', '手机号码', '邮箱', '账号', '帐号', '银行卡', '身份证', '支付密码',
  'password', 'verification code', 'one-time code', 'phone number', 'email address', 'account', 'card number',
];

const NORMAL = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** A click on this label would spend money or open a private conversation. */
export function clickRefusal(label: string): ClickRefusal | null {
  const text = NORMAL(label);
  if (DESTRUCTIVE_CONTROL.test(text)) return 'destructive';
  if (PAYMENT_ZH.some((word) => text.includes(word)) || PAYMENT_EN.test(text)) return 'payment';
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
  return WRITE_ACTIONS_ZH.some((word) => text.includes(word)) || WRITE_ACTION_EN.test(text);
}

/** A page control that copies a link into the local clipboard. */
export function isClipboardCopyControl(label: string): boolean {
  return /(?:复制|拷贝)\s*(?:链接|地址)?|\bcopy(?:\s+(?:the\s+)?)?(?:link|url)\b/i.test(NORMAL(label));
}

/** A destination option offered inside the page's share panel. */
export function isShareDestinationControl(label: string): boolean {
  return /(?:微信|朋友圈|QQ|微博|动态|分享到|分享给|转发)|\b(?:facebook|instagram|whatsapp|messenger|telegram|wechat|weibo|twitter|line|share to|send to)\b/i.test(NORMAL(label));
}

export function isShareDismissControl(label: string): boolean {
  return /^(?:关闭|取消|返回|close|cancel|back)$/i.test(NORMAL(label));
}

/**
 * A control that is already in the state a click would remove: 取消收藏, 已关注, unlike, unfollow.
 * Clicking it takes something back, so the World reports the state and leaves it alone.
 */
const UNDO = [
  /取消(?:点赞|收藏|关注|订阅)/, /已(?:赞|点赞|收藏|关注)/,
  /\bunlike\b/, /\bunliked\b/, /\bunfollow\b/, /\bunsave\b/, /\bunfavorite\b/,
  /\bliked\b/, /\bsaved\b/, /\bfavorited\b/, /\bfavourited\b/, /\bfollowing\b/,
  /remove from (?:favorites|saved|collection)/,
];
export function removesState(label: string): boolean {
  const text = NORMAL(label);
  return UNDO.some((pattern) => pattern.test(text));
}

/**
 * A control that submits text the person has not seen leave the browser yet. It only ever asks for a
 * confirmation; a label that looks like a code or a private message is left to the other refusals.
 */
const SEND_EXCLUSION = /验证码|短信|私信|消息|密码/;
const SEND_CONTROL = /(发送|发布|发表|投稿|提交)|\b(send|post|publish|submit)\b/;
export function isSendControl(label: string): boolean {
  const text = NORMAL(label);
  return !SEND_EXCLUSION.test(text) && SEND_CONTROL.test(text);
}

/** The Creator Center's final publication stays with the person reviewing the completed form. */
export function isFinalPublishControl(label: string): boolean {
  const text = NORMAL(label).replace(/\s*[（(]\s*\d+\s*\/\s*\d+\s*[）)]$/, '').trim();
  return /^(?:(?:立即|确认|定时)?(?:发布|投稿)(?:作品|视频)?|提交(?:作品|投稿|审核)?|publish(?: now| post| video)?|post now|submit(?: for review)?|schedule post)$/i.test(text);
}

/** Search and find boxes stay usable while the rest of the browser is read-only. */
export function isSearchField(element: { type?: string; label?: string; placeholder?: string; aria?: string; title?: string }): boolean {
  const type = NORMAL(element.type);
  if (type === 'search') return true;
  const text = NORMAL([element.label, element.placeholder, element.aria, element.title].filter(Boolean).join(' '));
  return /搜索|搜一下|查找|search|find/.test(text);
}

/** A target that opens the operating system's file picker can expose local files to a page. */
export function isFilePicker(element: { tag?: string; type?: string; filePicker?: boolean }): boolean {
  return element.filePicker === true || (NORMAL(element.tag) === 'input' && NORMAL(element.type) === 'file');
}
