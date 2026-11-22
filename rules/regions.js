// 地区表：省级默认值 + 市级覆盖。
// 覆盖中国大陆全部省级行政区及其地级行政区（直辖市按一个城市处理）。
// 工资标准全部为空，等数据核对后补入。
(function (root) {
  const CITY_LIST = `
北京市:北京
天津市:天津
上海市:上海
重庆市:重庆
河北省:石家庄,唐山,秦皇岛,邯郸,邢台,保定,张家口,承德,沧州,廊坊,衡水
山西省:太原,大同,阳泉,长治,晋城,朔州,晋中,运城,忻州,临汾,吕梁
内蒙古自治区:呼和浩特,包头,乌海,赤峰,通辽,鄂尔多斯,呼伦贝尔,巴彦淖尔,乌兰察布,兴安盟,锡林郭勒盟,阿拉善盟
辽宁省:沈阳,大连,鞍山,抚顺,本溪,丹东,锦州,营口,阜新,辽阳,盘锦,铁岭,朝阳,葫芦岛
吉林省:长春,吉林,四平,辽源,通化,白山,松原,白城,延边朝鲜族自治州
黑龙江省:哈尔滨,齐齐哈尔,鸡西,鹤岗,双鸭山,大庆,伊春,佳木斯,七台河,牡丹江,黑河,绥化,大兴安岭地区
江苏省:南京,无锡,徐州,常州,苏州,南通,连云港,淮安,盐城,扬州,镇江,泰州,宿迁
浙江省:杭州,宁波,温州,嘉兴,湖州,绍兴,金华,衢州,舟山,台州,丽水
安徽省:合肥,芜湖,蚌埠,淮南,马鞍山,淮北,铜陵,安庆,黄山,滁州,阜阳,宿州,六安,亳州,池州,宣城
福建省:福州,厦门,莆田,三明,泉州,漳州,南平,龙岩,宁德
江西省:南昌,景德镇,萍乡,九江,新余,鹰潭,赣州,吉安,宜春,抚州,上饶
山东省:济南,青岛,淄博,枣庄,东营,烟台,潍坊,济宁,泰安,威海,日照,临沂,德州,聊城,滨州,菏泽
河南省:郑州,开封,洛阳,平顶山,安阳,鹤壁,新乡,焦作,濮阳,许昌,漯河,三门峡,南阳,商丘,信阳,周口,驻马店,济源
湖北省:武汉,黄石,十堰,宜昌,襄阳,鄂州,荆门,孝感,荆州,黄冈,咸宁,随州,恩施土家族苗族自治州,仙桃,潜江,天门,神农架林区
湖南省:长沙,株洲,湘潭,衡阳,邵阳,岳阳,常德,张家界,益阳,郴州,永州,怀化,娄底,湘西土家族苗族自治州
广东省:广州,韶关,深圳,珠海,汕头,佛山,江门,湛江,茂名,肇庆,惠州,梅州,汕尾,河源,阳江,清远,东莞,中山,潮州,揭阳,云浮
广西壮族自治区:南宁,柳州,桂林,梧州,北海,防城港,钦州,贵港,玉林,百色,贺州,河池,来宾,崇左
海南省:海口,三亚,三沙,儋州
四川省:成都,自贡,攀枝花,泸州,德阳,绵阳,广元,遂宁,内江,乐山,南充,眉山,宜宾,广安,达州,雅安,巴中,资阳,阿坝藏族羌族自治州,甘孜藏族自治州,凉山彝族自治州
贵州省:贵阳,六盘水,遵义,安顺,毕节,铜仁,黔西南布依族苗族自治州,黔东南苗族侗族自治州,黔南布依族苗族自治州
云南省:昆明,曲靖,玉溪,保山,昭通,丽江,普洱,临沧,楚雄彝族自治州,红河哈尼族彝族自治州,文山壮族苗族自治州,西双版纳傣族自治州,大理白族自治州,德宏傣族景颇族自治州,怒江傈僳族自治州,迪庆藏族自治州
西藏自治区:拉萨,日喀则,昌都,林芝,山南,那曲,阿里地区
陕西省:西安,铜川,宝鸡,咸阳,渭南,延安,汉中,榆林,安康,商洛
甘肃省:兰州,嘉峪关,金昌,白银,天水,武威,张掖,平凉,酒泉,庆阳,定西,陇南,临夏回族自治州,甘南藏族自治州
青海省:西宁,海东,海北藏族自治州,黄南藏族自治州,海南藏族自治州,果洛藏族自治州,玉树藏族自治州,海西蒙古族藏族自治州
宁夏回族自治区:银川,石嘴山,吴忠,固原,中卫
新疆维吾尔自治区:乌鲁木齐,克拉玛依,吐鲁番,哈密,昌吉回族自治州,博尔塔拉蒙古自治州,巴音郭楞蒙古自治州,阿克苏地区,克孜勒苏柯尔克孜自治州,喀什地区,和田地区,伊犁哈萨克自治州,塔城地区,阿勒泰地区,石河子,阿拉尔,图木舒克,五家渠,北屯,铁门关,双河,可克达拉,昆玉,胡杨河,新星,白杨
`;

  const PROVINCES = CITY_LIST.trim().split('\n').map(line => {
    const [province, cities] = line.split(':');
    return { province, cities: cities.split(',') };
  });

  // 字段按「劳动仲裁法条库与计算规则校准」文档第 4.1 节。金额按年度保存：
  // 计算取解除时已公布的「上年度」数值，不取最新值。
  //   avg_wage:  { <年度>: { value, scope: '职工平均' | '全口径', published, url } }  按用人单位所在的直辖市或设区的市
  //   min_wage:  [{ from: 'YYYY-MM-DD', value, tier, url }]  省内分档时市级覆盖写本市所在档
  //   overtime_in_base:   经济补偿基数是否含加班费：'是' | '否' | '有争议'
  //   bonus_allocation:   年终奖分摊：'按 12 个月分摊' | '计入发放月' | '有争议'
  //   double_wage_limitation: 二倍工资时效：'逐月' | '整体' | '从补订或视为无固定期限之日起算'
  //   monthly_workdays:   不满一个月折算用的月计薪天数 D，默认 21.75（不是全国法定规则，按地区参数存）
  // 没有数据的一律为空或「有争议」，页面提示「该地标准待补，可自行填写」。
  // application_format：申请书格式与份数。法定栏目全国统一（调解仲裁法第 28 条），格式、份数、是否线上立案各地不同，按地区填
  const POLICY_FIELDS = ['overtime_in_base', 'bonus_allocation', 'double_wage_limitation', 'monthly_workdays', 'application_format'];
  const DEFAULT_APP_FORMAT = { copies: '正本 1 份，并按被申请人人数提交副本', template: null, online: null, note: '格式和份数以当地仲裁委要求为准' };
  const PROVINCE_DEFAULTS = {};
  for (const p of PROVINCES) {
    PROVINCE_DEFAULTS[p.province] = { avg_wage: {}, min_wage: [], overtime_in_base: '有争议', bonus_allocation: '有争议', double_wage_limitation: '有争议', monthly_workdays: 21.75, application_format: DEFAULT_APP_FORMAT, review: '待校准' };
  }

  // 市级覆盖：只写和省级默认不同的字段，例如 { '深圳': { avg_wage: { 2025: { value: 12345, scope: '职工平均' } } } }
  const CITY_OVERRIDES = {};

  function provinceOf(city) {
    const p = PROVINCES.find(p => p.cities.includes(city));
    return p ? p.province : null;
  }

  // 某城市在某日（解除日）生效的标准，逐字段标明来源（市级 / 省级 / 待补）
  function standardsFor(city, onDate) {
    const province = provinceOf(city);
    if (!province) return null;
    const base = PROVINCE_DEFAULTS[province];
    const over = CITY_OVERRIDES[city] || {};
    const year = (onDate ? +onDate.slice(0, 4) : new Date().getFullYear()) - 1;
    const out = { city, province, year, origin: {} };
    const avg = (over.avg_wage && over.avg_wage[year]) ? [over.avg_wage[year], '市级'] : (base.avg_wage[year] ? [base.avg_wage[year], '省级'] : [null, '待补']);
    out.avg_wage = avg[0] ? avg[0].value : null; out.avg_wage_scope = avg[0] ? avg[0].scope : null; out.origin.avg_wage = avg[1];
    const list = (over.min_wage && over.min_wage.length) ? [over.min_wage, '市级'] : (base.min_wage.length ? [base.min_wage, '省级'] : [[], '待补']);
    const day = onDate || new Date().toISOString().slice(0, 10);
    const mw = list[0].filter(m => m.from <= day).sort((a, b) => a.from < b.from ? 1 : -1)[0];
    out.min_wage = mw ? mw.value : null; out.origin.min_wage = mw ? list[1] : '待补';
    for (const k of POLICY_FIELDS) { out[k] = over[k] || base[k]; out.origin[k] = over[k] ? '市级' : '省级'; }
    return out;
  }

  const api = { PROVINCES, PROVINCE_DEFAULTS, CITY_OVERRIDES, provinceOf, standardsFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LA = Object.assign(root.LA || {}, { regions: api });
})(this);
