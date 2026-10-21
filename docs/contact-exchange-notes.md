# 私信与自愿交换联系方式：分步修改记录

按用户要求，每个逻辑步骤检查后直接 commit、push 到 main。数据库操作单独说明，不自动迁移正式数据库。

## 设计依据与约定

- [Signal 消息请求](https://support.signal.org/hc/en-us/articles/360007459591-Signal-Profiles-and-Message-Requests)：接收方明确接受或拒绝。
- [Upwork 联系方式隐私](https://support.upwork.com/hc/en-us/articles/360051749534-How-to-keep-your-contact-information-safe-on-Upwork)：站内沟通与外部联系方式分开处理。这里只参考隐私原则，不引入平台合同规则。
- 私信不要求填写或交换联系方式；商品详情不再向登录用户直接提供私人号码。
- 一方申请并选择愿意分享的方式，对方明确同意并选择自己的方式后才双方可见。
- 申请可撤回、拒绝和过期；已同意可停止共享，但无法撤回对方已看到或另存的号码。
- 同意仅针对该对话及本次选择的信息；不自动共享账户的所有联系方式，不把号码写入普通聊天或消息列表预览。

## 步骤 1：先关闭旧接口的直接读取

`/api/products/:id/contact` 仅发布者本人可读，其他已登录用户也不能绕过界面获取号码。原有私信入口继续可用；商品编辑仍能读取自己的历史私密记录。
