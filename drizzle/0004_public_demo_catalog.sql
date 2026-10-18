ALTER TABLE `products` ADD `is_demo` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO users (id, display_name, created_at) VALUES ('juzi_demo_catalog', '示例展示账号', 1792306800000);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_01', 'juzi_demo_catalog', '宿舍小风扇，把微风带回书桌', 'appliance', 3500, 12900, '九成新', 'SIP 校区', 'SIP 校区 · 图书馆入口（示例）', '陪我度过一个夏天的小风扇，风力可调，运行正常。桌面大小刚刚好，搬宿舍所以转给需要的同学，支持现场试用。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"型号":"桌面循环扇（演示）","使用情况":"使用一学期，功能正常","配件":"电源线齐全"}', 0, '小林同学（示例）', 'active', 1792305000000, 1792305000000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_07', 'juzi_demo_catalog', '校园代步电瓶车，早八不慌张', 'ebike', 128000, 369900, '九成新', 'SIP 校区', 'SIP 校区 · 图书馆入口（示例）', '毕业转让，平时用来往返教学楼和宿舍。车身有正常使用痕迹，刹车、车灯运行正常，可约时间在校内看车。续航为卖家自述演示值。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"购入时间":"2025 年 9 月（演示）","电池情况":"充放电正常，支持现场检查","卖家自述续航":"约 35 公里，仅演示数据"}', 1, '阿橘（示例）', 'active', 1792303200000, 1792303200000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_13', 'juzi_demo_catalog', '简简单单的白色陶瓷杯', 'daily', 1200, 4900, '几乎全新', '太仓校区', '太仓校区 · 公共服务区（示例）', '手感很舒服的白色马克杯，买回来只用过两次。没有缺口，已经清洗干净，适合放在宿舍喝水或泡咖啡。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"尺寸":"约 350 毫升","数量":"1 只","使用情况":"使用两次，无缺口"}', 0, '一颗小豆（示例）', 'active', 1792301400000, 1792301400000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_02', 'juzi_demo_catalog', '奶油白电热水壶，早餐好搭子', 'appliance', 6800, 19900, '九成新', '太仓校区', '太仓校区 · 公共服务区（示例）', '外观干净，烧水和自动断电功能正常。因为换了更小的水壶闲置，愿意送给下一位认真吃早餐的同学。仅在学校允许的场景使用。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"型号":"1.5L 电热水壶（演示）","使用情况":"使用半年，功能正常","配件":"原装底座"}', 0, '周末睡饱（示例）', 'active', 1792299600000, 1792299600000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_14', 'juzi_demo_catalog', '运动搭子 · 加厚瑜伽垫', 'daily', 2800, 8900, '九成新', 'SIP 校区', 'SIP 校区 · 图书馆入口（示例）', '上学期买来做拉伸的瑜伽垫，使用频率不高，表面干净。卷起来可以放在床下，约在图书馆门口面交。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"尺寸":"183 × 61 厘米（演示）","数量":"1 张","使用情况":"使用约 10 次，已清洁"}', 0, '今天也要动（示例）', 'active', 1792296000000, 1792296000000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_03', 'juzi_demo_catalog', '红色吹风机，洗完头不用等', 'appliance', 4500, 15900, '八成新', 'SIP 校区', 'SIP 校区 · 图书馆入口（示例）', '风力够用，冷热风都正常，手柄上有轻微使用痕迹。毕业整理闲置，送原装风嘴，可现场通电试用。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"型号":"家用吹风机（演示）","使用情况":"使用一年，冷热风正常","配件":"集风嘴"}', 1, '晚风（示例）', 'active', 1792292400000, 1792292400000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_08', 'juzi_demo_catalog', '毕业转让 · 通勤电瓶车', 'ebike', 98000, 289900, '八成新', '太仓校区', '太仓校区 · 公共服务区（示例）', '毕业不方便带回家，想转给校内有需要的同学。日常代步够用，有一些刮擦，建议看车试骑后再决定。充电器一起带走。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"购入时间":"2024 年 10 月（演示）","电池情况":"使用两年，建议现场检查","卖家自述续航":"约 25 公里，仅演示数据"}', 1, '明天见（示例）', 'active', 1792288800000, 1792288800000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_15', 'juzi_demo_catalog', '桌面绿意 · 小多肉连盆', 'daily', 1500, 3900, '几乎全新', '太仓校区', '太仓校区 · 公共服务区（示例）', '很好照顾的一盆小多肉，搬到新宿舍窗台放不下了。花盆和植物一起转，给书桌添一点绿色。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"尺寸":"盆口直径约 10 厘米","数量":"1 盆","使用情况":"长势良好，连盆转让"}', 0, '绿豆冰（示例）', 'active', 1792285200000, 1792285200000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_04', 'juzi_demo_catalog', '黑色头戴耳机，给自习一点安静', 'appliance', 8900, 29900, '九成新', '太仓校区', '太仓校区 · 公共服务区（示例）', '平时在自习室听轻音乐用的耳机，声音正常，耳罩干净。有线连接，接口请看详情，欢迎面交检查。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"型号":"有线头戴耳机（演示）","使用情况":"使用一学期，双耳声音正常","配件":"音频线"}', 0, '图书馆常客（示例）', 'active', 1792281600000, 1792281600000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_09', 'juzi_demo_catalog', '电动代步车，带你穿过校园', 'ebike', 168000, 429900, '几乎全新', 'SIP 校区', 'SIP 校区 · 图书馆入口（示例）', '购入后骑得不多，车身和座椅状态比较好。换了更近的宿舍后闲置，车况和电池可以当面查看，演示信息不代表真实车辆参数。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"购入时间":"2026 年 3 月（演示）","电池情况":"充放电正常，使用较少","卖家自述续航":"约 40 公里，仅演示数据"}', 0, '小满（示例）', 'active', 1792278000000, 1792278000000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_16', 'juzi_demo_catalog', '晴雨都陪你 · 黄色雨伞', 'daily', 1800, 5900, '九成新', 'SIP 校区', 'SIP 校区 · 图书馆入口（示例）', '很显眼的一把黄色雨伞，伞骨完好、开合顺畅。不用再从食堂一路淋雨回宿舍啦，校内面交。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"尺寸":"展开直径约 95 厘米（演示）","数量":"1 把","使用情况":"伞骨完好，无破损"}', 0, '雨过天晴（示例）', 'active', 1792274400000, 1792274400000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_05', 'juzi_demo_catalog', '桌面小音箱，周末的松弛感', 'appliance', 12000, 39900, '九成新', 'SIP 校区', 'SIP 校区 · 图书馆入口（示例）', '听歌和播客的小音箱，声音正常。桌面整理换了设备，想给它找一个新主人，配件一起带走。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"型号":"桌面音箱（演示）","使用情况":"使用半年，播放正常","配件":"连接线和电源线"}', 0, '星期六（示例）', 'active', 1792270800000, 1792270800000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_10', 'juzi_demo_catalog', '轻松代步电瓶车，校内面交', 'ebike', 118000, 329900, '九成新', '太仓校区', '太仓校区 · 公共服务区（示例）', '一直在校内骑，平时会放在车棚。转向灯、刹车和喇叭可当面检查。可以在公共服务区（示例）附近看车，附充电器。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"购入时间":"2025 年 5 月（演示）","电池情况":"日常充电正常","卖家自述续航":"约 30 公里，仅演示数据"}', 0, '早八选手（示例）', 'active', 1792263600000, 1792263600000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_17', 'juzi_demo_catalog', '条纹折叠椅，带去草坪坐坐', 'daily', 3800, 12900, '八成新', '太仓校区', '太仓校区 · 公共服务区（示例）', '适合周末去草坪聊天的小折叠椅，收纳不占位置。椅面有正常使用痕迹，支架稳固，面交可打开检查。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"尺寸":"成人单人折叠椅（演示）","数量":"1 把","使用情况":"使用一学年，支架稳固"}', 1, '去看日落（示例）', 'active', 1792256400000, 1792256400000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_06', 'juzi_demo_catalog', '书桌台灯，让复习温柔一点', 'appliance', 3900, 13900, '九成新', '太仓校区', '太仓校区 · 公共服务区（示例）', '陪我写完很多作业的台灯，照明正常，角度可以调节。毕业整理，希望它继续陪另一位同学度过考试周。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"型号":"书桌阅读灯（演示）","使用情况":"使用一年，照明正常","配件":"电源适配器"}', 1, '认真发呆（示例）', 'active', 1792249200000, 1792249200000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_11', 'juzi_demo_catalog', '校园电瓶车，通勤好朋友', 'ebike', 148000, 389900, '九成新', 'SIP 校区', 'SIP 校区 · 图书馆入口（示例）', '教学楼离宿舍比较远时买的车。骑行平稳，有轻微日常使用痕迹，可现场检查车灯、刹车和电池，演示商品仅供体验。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"购入时间":"2025 年 11 月（演示）","电池情况":"约使用一年，充放电正常","卖家自述续航":"约 38 公里，仅演示数据"}', 0, '慢慢来（示例）', 'active', 1792242000000, 1792242000000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_18', 'juzi_demo_catalog', '白色马克杯，留给下一杯热茶', 'daily', 900, 3500, '九成新', 'SIP 校区', 'SIP 校区 · 图书馆入口（示例）', '毕业转让的日用杯，外观简洁，已经清洗干净。无缺口和明显划痕，适合放在书桌上喝水。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"尺寸":"约 350 毫升","数量":"1 只","使用情况":"使用一学期，已清洁"}', 1, '热茶不加糖（示例）', 'active', 1792227600000, 1792227600000, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo) VALUES ('demo_juzi_12', 'juzi_demo_catalog', '毕业季代步车，约个时间看车', 'ebike', 88000, 249900, '八成新', '太仓校区', '太仓校区 · 公共服务区（示例）', '毕业清闲置，老朋友还可以继续陪你赶早八。外壳有刮擦，车况请当面确认，支持校内看车。页面续航及价格均为虚构演示。

这是虚构的示例商品，照片为素材图片，仅用于体验页面；没有真实卖家或联系方式，不能交易。', '{"购入时间":"2024 年 6 月（演示）","电池情况":"使用两年，有自然衰减","卖家自述续航":"约 22 公里，仅演示数据"}', 1, '最后一排（示例）', 'active', 1792213200000, 1792213200000, 1);
