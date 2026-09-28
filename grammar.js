/* 一句一句读 · 离线语法引擎（规则式分析，无需联网） */
(function (root) {
'use strict';

// ---------- 不规则动词表：原形 过去式 过去分词 ----------
const IRR_RAW = `arise arose arisen
awake awoke awoken
be was/were been
bear bore born/borne
beat beat beaten
become became become
begin began begun
bend bent bent
bet bet bet
bind bound bound
bite bit bitten
bleed bled bled
blow blew blown
break broke broken
breed bred bred
bring brought brought
build built built
burn burnt/burned burnt/burned
burst burst burst
buy bought bought
catch caught caught
choose chose chosen
cling clung clung
come came come
cost cost cost
creep crept crept
cut cut cut
deal dealt dealt
dig dug dug
do did done
draw drew drawn
dream dreamt/dreamed dreamt/dreamed
drink drank drunk
drive drove driven
eat ate eaten
fall fell fallen
feed fed fed
feel felt felt
fight fought fought
find found found
flee fled fled
fling flung flung
fly flew flown
forbid forbade forbidden
forget forgot forgotten
forgive forgave forgiven
freeze froze frozen
get got got/gotten
give gave given
go went gone
grind ground ground
grow grew grown
hang hung hung
have had had
hear heard heard
hide hid hidden
hit hit hit
hold held held
hurt hurt hurt
keep kept kept
kneel knelt knelt
know knew known
lay laid laid
lead led led
lean leant/leaned leant/leaned
leap leapt/leaped leapt/leaped
learn learnt/learned learnt/learned
leave left left
lend lent lent
let let let
lie lay lain
light lit lit
lose lost lost
make made made
mean meant meant
meet met met
mistake mistook mistaken
overcome overcame overcome
pay paid paid
put put put
quit quit quit
read read read
ride rode ridden
ring rang rung
rise rose risen
run ran run
say said said
see saw seen
seek sought sought
sell sold sold
send sent sent
set set set
sew sewed sewn
shake shook shaken
shine shone shone
shoot shot shot
show showed shown
shrink shrank shrunk
shut shut shut
sing sang sung
sink sank sunk
sit sat sat
sleep slept slept
slide slid slid
smell smelt/smelled smelt/smelled
speak spoke spoken
speed sped sped
spell spelt/spelled spelt/spelled
spend spent spent
spill spilt/spilled spilt/spilled
spin spun spun
spit spat spat
split split split
spoil spoilt/spoiled spoilt/spoiled
spread spread spread
spring sprang sprung
stand stood stood
steal stole stolen
stick stuck stuck
sting stung stung
stink stank stunk
strike struck struck
swear swore sworn
sweep swept swept
swim swam swum
swing swung swung
take took taken
teach taught taught
tear tore torn
tell told told
think thought thought
throw threw thrown
understand understood understood
upset upset upset
wake woke woken
wear wore worn
weep wept wept
win won won
wind wound wound
withdraw withdrew withdrawn
write wrote written`;

const PAST = Object.create(null), PP = Object.create(null);
IRR_RAW.trim().split('\n').forEach(function (line) {
  const p = line.trim().split(/\s+/);
  if (p.length < 3) return;
  p[1].split('/').forEach(f => { if (!(f in PAST)) PAST[f] = p[0]; });
  p[2].split('/').forEach(f => { if (!(f in PP)) PP[f] = p[0]; });
});

const set = s => new Set(s.split(/\s+/).filter(Boolean));
const BE_ALL = set('am is are was were be been being');
const MODALS = set('can could may might must should would shall will ought');
const SUBJ = set('i you he she it we they');
const DET_ONLY = set('the a an my your his her its our their this that these those some any no every each');
const DET_TO = set('the a an my your his her its our their this that these those some any no every each me him us them you it her one all both school bed church town');
const SKIP = set('not never always often also just already still ever really only even soon then probably usually sometimes finally recently certainly actually simply quickly slowly clearly perhaps surely suddenly almost nearly hardly rarely seldom all both');
const ING_NOT = set('thing nothing something anything everything morning evening king ring sing bring spring string sting swing wing during ceiling building wedding pudding darling sibling cling fling sling wring lightning');
const ADJ_ING = set('interesting boring exciting amazing surprising charming confusing annoying disappointing frightening shocking tiring relaxing satisfying embarrassing astonishing terrifying thrilling fascinating missing willing outstanding loving caring amusing pleasing worrying touching moving');
const ADJ_ED = set('tired excited interested surprised bored worried scared frightened pleased satisfied married confused embarrassed disappointed amazed shocked annoyed ashamed astonished delighted exhausted relieved determined dressed lost gone done finished closed crowded pleased puzzled terrified upset hurt used');
const ED_NOT = set('need feed seed speed bed red shed bleed breed indeed hundred sled wed shred proceed succeed exceed weed greed deed reed steed naked wicked sacred rugged ragged crooked jagged kindred hatred bred');
const OBJ_V = set('say says said think thinks thought know knows knew believe believes believed hope hoped feel felt realize realized realise realised see saw hear heard tell told show showed mean meant sure afraid glad wonder wondered ask asked understand understood remember remembered forget forgot decide decided find found notice noticed explain explained suppose guess learn learned agree agreed doubt idea certain true clear aware');
const IMP = set('let please go come look take give be do stop listen wait tell try keep remember forget sit stand open close put bring make get show turn run help read write say call leave follow hurry watch hold imagine consider check');
const WH = set('what who whom whose which where when why how');
const AUX_Q = set('am is are was were do does did have has had can could will would shall should may might must');
const PRON_S = set('it he she that what there here who where how this everything nothing something everyone somebody nobody anyone');
const BLOCK_PREV = set('the a an my your his her its our their this that these those very so too more most less least have has had to get gets got become became feel felt seem seemed look looked quite rather');
const PREP = set('of in for about without after before by on at from instead like besides');
const GER_V = set('enjoy enjoys enjoyed finish finished finishes stop stopped stops keep kept keeps mind avoid avoided start started began begin like liked love loved hate hated miss missed practice practise suggest suggested imagine imagined consider considered quit go went goes');
const NEG = set('not never no nothing nobody none neither nor nowhere');
const EST_NOT = set('rest west test nest chest interest forest guest request protest contest quest honest modest east');

const MODAL_MEAN = {
  can: '能力或许可：能、会、可以',
  could: 'can 的过去式；也表示委婉请求或可能性：能、可能',
  may: '许可或可能：可以、也许',
  might: '较弱的可能性：可能、也许',
  must: '必须；或有把握的推测：一定',
  should: '应该；表示建议或义务',
  would: '过去将来、意愿、委婉语气或虚拟：会、愿意',
  shall: '将要；用于 I/we 征求意见：……好吗',
  ought: 'ought to：应该'
};

const ADV_CONJ = {
  'as soon as': '时间（一……就）', 'even though': '让步（即使、尽管）', 'even if': '让步（即使）',
  'so that': '目的（以便）', 'as if': '方式（好像）', 'as though': '方式（好像）',
  'now that': '原因（既然）', 'in case': '条件（以防）',
  because: '原因（因为）', although: '让步（虽然）', though: '让步（虽然）',
  while: '时间或对比（当……时／而）', when: '时间（当……时）', whenever: '时间（每当）',
  whereas: '对比（而）', until: '时间（直到）', till: '时间（直到）',
  before: '时间（在……之前）', after: '时间（在……之后）', since: '原因或时间（因为／自从）', once: '时间或条件（一旦）'
};
const NEED_SUBJ_CONJ = set('before after since once until till');

// ---------- 语法字典 ----------
const REF = {
  simple_present: { t: '一般现在时', f: '主语 + 动词原形（第三人称单数加 -s/-es）；be 用 am/is/are', b: '表示经常发生的动作、习惯、客观事实或现在的状态。', eg: ['She walks to school every day.｜她每天走路上学。', 'Water boils at 100 degrees.｜水在100度沸腾。'] },
  simple_past: { t: '一般过去时', f: '主语 + 动词过去式（规则动词加 -ed，不规则动词需记忆）', b: '表示过去某个时间发生的动作或存在的状态，小说的叙述大多用这个时态。', eg: ['We visited the museum last Sunday.｜上周日我们参观了博物馆。', 'He found his keys under the sofa.｜他在沙发下找到了钥匙。'] },
  simple_future: { t: '一般将来时', f: 'will / shall + 动词原形', b: '表示将来会发生的动作、临时做出的决定或预测。', eg: ['I will call you tonight.｜我今晚给你打电话。'] },
  be_going_to: { t: 'be going to 结构', f: 'am/is/are + going to + 动词原形', b: '表示已经计划好的打算，或根据迹象判断即将发生的事。was/were going to 表示"当时打算"。', eg: ['Look at the clouds. It is going to rain.｜看这些云，要下雨了。'] },
  present_continuous: { t: '现在进行时', f: 'am/is/are + 动词-ing', b: '表示此刻正在进行的动作，或近期已安排好要做的事。', eg: ['They are playing football now.｜他们正在踢足球。'] },
  past_continuous: { t: '过去进行时', f: 'was/were + 动词-ing', b: '表示过去某一时刻正在进行的动作，常用来描写故事背景，或与 when / while 连用。', eg: ['I was reading when the phone rang.｜电话响时我正在看书。'] },
  future_continuous: { t: '将来进行时', f: 'will be + 动词-ing', b: '表示将来某一时刻正在进行的动作。', eg: ['This time tomorrow I will be flying home.｜明天这个时候我正在飞回家的路上。'] },
  present_perfect: { t: '现在完成时', f: 'have/has + 过去分词', b: '表示过去的动作对现在造成的结果，或从过去持续到现在的状态，常与 already、yet、ever、never、since、for 连用。', eg: ['I have finished my homework.｜我已经做完作业了。', 'She has lived here since 2010.｜她从2010年起就住在这里。'] },
  past_perfect: { t: '过去完成时', f: 'had + 过去分词', b: '"过去的过去"：表示在过去某个时间或动作之前已经完成的事，小说里常用来回忆往事。', eg: ['When we arrived, the train had already left.｜我们到达时，火车已经开走了。'] },
  future_perfect: { t: '将来完成时', f: 'will have + 过去分词', b: '表示到将来某一时间为止将已完成的动作。', eg: ['By next June, I will have graduated.｜到明年六月，我将已经毕业。'] },
  perfect_continuous: { t: '完成进行时', f: 'have/has/had been + 动词-ing', b: '强调某动作从过去一直持续（到现在或到过去某时），而且可能还在继续。', eg: ['It has been raining all day.｜雨下了一整天了。'] },
  passive: { t: '被动语态', f: 'be（随时态变化）+ 过去分词（+ by 动作执行者）', b: '主语是动作的承受者而不是执行者。当执行者不重要、不清楚，或想强调承受者时使用。', eg: ['The window was broken by the boy.｜窗户被那个男孩打破了。', 'English is spoken all over the world.｜全世界都说英语。'] },
  modal: { t: '情态动词', f: '情态动词 + 动词原形', b: '表示能力、许可、义务、推测等说话人的态度，本身没有人称和数的变化。can 能／可以；could 能（过去）／委婉；may 可以／也许；might 也许；must 必须／一定；should 应该；would 愿意／委婉／虚拟。', eg: ['You should drink more water.｜你应该多喝水。', 'She might be at home.｜她可能在家。'] },
  modal_perfect: { t: '情态动词 + 完成式', f: 'must/may/might/could/should/would + have + 过去分词', b: '对过去情况的推测或虚拟：must have done 过去一定做了；may/might have done 过去可能做了；should have done 本应该做（却没做）；could have done 本来能做到。', eg: ['You should have told me earlier.｜你本应早点告诉我。'] },
  be_linking: { t: '系动词 be（主系表结构）', f: '主语 + am/is/are/was/were + 表语（名词、形容词、介词短语等）', b: 'be 在这里不表示动作，而是连接主语和表语，说明主语"是什么、怎么样、在哪里"。', eg: ['The soup is hot.｜汤很烫。', 'My parents were at home.｜我父母当时在家。'] },
  have_to: { t: 'have to 结构', f: 'have/has/had + to + 动词原形', b: '表示客观上"不得不"。否定 don\'t have to 意为"不必"。', eg: ['I have to get up early tomorrow.｜我明天不得不早起。'] },
  do_aux: { t: '助动词 do / does / did', f: 'do/does/did + (not) + 动词原形', b: '用于构成一般现在时、一般过去时的否定句和疑问句，也可放在动词前表示强调。did 后面的动词一定用原形。', eg: ['He did not come yesterday.｜他昨天没来。', 'Do you like music?｜你喜欢音乐吗？'] },
  used_to: { t: 'used to 结构', f: 'used to + 动词原形（过去常常）；be/get used to + 名词或动名词（习惯于）', b: 'used to do 表示过去经常做而现在不做了；be used to doing 表示"习惯于做某事"，两者不要混淆。', eg: ['I used to live in the countryside.｜我过去住在乡下。'] },
  subjunctive: { t: '虚拟语气', f: '与现在事实相反：If + 过去式（be 用 were），主句 would/could/might + 原形；与过去事实相反：If + had done，主句 would have done', b: '表示假设的、与事实相反或不太可能的情况。wish 后面的从句也常用虚拟语气。', eg: ['If I were you, I would take the job.｜如果我是你，我会接受这份工作。', 'I wish I had more time.｜但愿我有更多时间。'] },
  sentence_types: { t: '简单句、并列句与复合句', f: '简单句：一套主谓；并列句：两个平等的分句；复合句：主句 + 从句', b: '读长句时先找主句的主语和谓语，再看连词划分出从句，这是读懂英文书最实用的技巧。', eg: ['I like tea.｜简单句', 'I like tea, but she likes coffee.｜并列句', 'I like tea because it is healthy.｜复合句'] },
  there_be: { t: 'There be 句型', f: 'There + be + 名词 + 地点／时间', b: '表示"某处有某物"。be 的单复数由紧跟其后的名词决定（就近原则）。', eg: ['There is a cat under the table.｜桌子下面有一只猫。'] },
  yes_no_question: { t: '一般疑问句', f: '助动词／be／情态动词 + 主语 + ……？', b: '把助动词或 be 动词提到主语前面，用 yes 或 no 回答。', eg: ['Are you ready?｜你准备好了吗？'] },
  wh_question: { t: '特殊疑问句', f: '疑问词（what / who / where / when / why / how）+ 一般疑问句语序', b: '用疑问词询问具体信息，不能用 yes / no 回答。', eg: ['Where did you put my phone?｜你把我的手机放哪儿了？'] },
  tag_question: { t: '反意疑问句', f: '陈述句，+ 助动词 + 代词？', b: '"前肯后否，前否后肯"，用来确认信息，相当于"……，对吧？"', eg: ['It is a nice day, isn\'t it?｜今天天气很好，不是吗？'] },
  exclamation: { t: '感叹句', f: 'What + (a/an) + 形容词 + 名词 (+ 主谓)！／ How + 形容词或副词 (+ 主谓)！', b: '表达强烈的情感。', eg: ['What a beautiful garden!｜多漂亮的花园啊！', 'How fast he runs!｜他跑得真快！'] },
  imperative: { t: '祈使句', f: '动词原形开头（否定：Don\'t + 动词原形）', b: '表示命令、请求或建议，主语 you 通常省略。Let\'s …… 表示"我们一起……吧"。', eg: ['Close the door, please.｜请关门。', 'Don\'t be late.｜别迟到。'] },
  direct_speech: { t: '直接引语', f: '"……," he said.', b: '用引号原样引用人物说的话，小说对话中非常常见。引号内部可以是任何句型。', eg: ['"I am hungry," said Tom.｜"我饿了，"汤姆说。'] },
  negation: { t: '否定', f: 'not / never / no / nothing / nobody ……', b: 'not 放在助动词、be 动词或情态动词之后；never 表示"从不"；no + 名词表示"没有"。', eg: ['I have never been to Paris.｜我从没去过巴黎。'] },
  adverbial_clause: { t: '状语从句', f: '连词（when / because / although / before / until ……）+ 从句', b: '从句修饰主句，说明时间、原因、让步、目的、条件等。从句可放在主句前（常用逗号隔开），也可放在后面。', eg: ['I went to bed because I was tired.｜因为累了，我就去睡了。', 'Although it was cold, he went swimming.｜虽然天冷，他还是去游泳了。'] },
  conditional: { t: '条件状语从句', f: 'If / Unless + 从句，主句', b: 'if 表示"如果"，unless 表示"除非"。真实条件下"主将从现"：主句用将来时，从句用一般现在时表示将来。', eg: ['If it rains tomorrow, we will stay at home.｜如果明天下雨，我们就待在家里。'] },
  relative_clause: { t: '定语从句', f: '先行词（名词）+ who / whom / whose / which / that / where / when + 从句', b: '从句像一个"长形容词"，放在名词后面修饰它。who 指人，which 指物，that 人和物都可以，whose 表示"……的"。', eg: ['The girl who is singing is my sister.｜正在唱歌的女孩是我妹妹。', 'This is the book which I bought yesterday.｜这是我昨天买的书。'] },
  object_clause: { t: '宾语从句', f: '动词（say / think / know / ask ……）+ (that / if / whether / 疑问词) + 从句', b: '整个从句作动词的宾语，说明"说了、想了、知道了什么"。that 在口语中常省略；从句用陈述句语序。', eg: ['I think (that) he is right.｜我认为他是对的。', 'Do you know where she lives?｜你知道她住在哪儿吗？'] },
  noun_clause: { t: '名词性从句（what 引导）', f: 'what + 从句 = "……的东西／事情"', b: 'what 引导的从句相当于一个名词，可以作主语、宾语或表语。', eg: ['What you said is true.｜你说的是真的。'] },
  coordination: { t: '并列句', f: '分句 1 + and / but / or / so + 分句 2', b: '用并列连词把两个地位平等的句子连起来：and 并列，but 转折，or 选择，so 结果。', eg: ['I was hungry, so I made a sandwich.｜我饿了，所以做了个三明治。'] },
  correlative: { t: '成对连词', f: 'not only … but (also) ／ either … or ／ neither … nor ／ both … and', b: '成对使用，连接两个并列成分。', eg: ['Both Tom and Lucy like music.｜汤姆和露西都喜欢音乐。'] },
  so_that: { t: 'so / such … that 结构', f: 'so + 形容词／副词 + that 从句；such + (a/an) + 名词 + that 从句', b: '表示"如此……以至于……"，that 后面是结果。', eg: ['He was so tired that he fell asleep at once.｜他太累了，立刻就睡着了。'] },
  infinitive: { t: '动词不定式', f: 'to + 动词原形', b: '可以作宾语（want to go）、目的状语（came to help）、定语（something to eat）等。注意：若 to 后面是名词或代词，to 是介词而不是不定式。', eg: ['She wants to learn Chinese.｜她想学中文。', 'He came here to see you.｜他来这里是为了见你。'] },
  too_to: { t: 'too … to 结构', f: 'too + 形容词／副词 + to do', b: '表示"太……而不能……"，形式肯定、意思否定。', eg: ['The box is too heavy to carry.｜这箱子太重了，搬不动。'] },
  gerund: { t: '动名词', f: '动词-ing 当名词用', b: '可作主语（Swimming is fun），也可作介词或某些动词（enjoy、finish、stop 等）的宾语。', eg: ['Reading helps you learn new words.｜阅读帮助你学习新单词。', 'Thank you for helping me.｜谢谢你帮助我。'] },
  participle: { t: '分词作状语', f: '动词-ing／过去分词短语 + 逗号 + 主句（或主句 + 逗号 + 分词短语）', b: '分词短语修饰整个句子，表示伴随、时间、原因等，它的逻辑主语通常就是主句的主语。', eg: ['Walking in the park, I met an old friend.｜在公园散步时，我遇到了一个老朋友。'] },
  formal_subject: { t: '形式主语 it', f: 'It + be + 形容词／名词 + to do ／ that 从句', b: '真正的主语（不定式或从句）太长，就用 it 放在句首占位，把真正的主语放到后面。', eg: ['It is important to exercise every day.｜每天锻炼很重要。'] },
  comparative: { t: '比较级', f: '形容词／副词比较级（-er 或 more ……）+ than', b: '用于两者比较。单音节词多加 -er，多音节词前加 more。', eg: ['My room is bigger than yours.｜我的房间比你的大。'] },
  superlative: { t: '最高级', f: 'the + 最高级（-est 或 most ……）', b: '用于三者及以上的比较，表示"最……"。', eg: ['This is the most interesting book I have ever read.｜这是我读过最有趣的书。'] },
  as_as: { t: '同级比较 as … as', f: 'as + 形容词／副词原级 + as', b: '表示"和……一样"；not as / so … as 表示"不如……"。', eg: ['He runs as fast as his brother.｜他跑得和他哥哥一样快。'] },
  contraction: { t: '缩写形式', f: 'I\'m = I am；don\'t = do not；it\'s = it is / it has；he\'d = he would / he had', b: '口语和小说对话中非常常见。\'s 可能是 is、has 或名词所有格；\'d 可能是 would 或 had，要结合上下文判断。', eg: ['I\'ll be back soon.｜我很快回来。（I\'ll = I will）'] },
  possessive: { t: '名词所有格', f: '名词 + \'s（以 s 结尾的复数只加 \'）', b: '表示"……的"，如 Tom\'s bag 汤姆的包，the girls\' room 女孩们的房间。', eg: ['This is my father\'s car.｜这是我爸爸的车。'] }
};

const GROUPS = [
  ['时态', ['simple_present', 'simple_past', 'simple_future', 'be_going_to', 'present_continuous', 'past_continuous', 'future_continuous', 'present_perfect', 'past_perfect', 'future_perfect', 'perfect_continuous']],
  ['语态与情态', ['passive', 'modal', 'modal_perfect', 'have_to', 'do_aux', 'used_to', 'subjunctive']],
  ['句子类型', ['sentence_types', 'be_linking', 'there_be', 'yes_no_question', 'wh_question', 'tag_question', 'exclamation', 'imperative', 'direct_speech', 'negation']],
  ['从句与连词', ['adverbial_clause', 'conditional', 'relative_clause', 'object_clause', 'noun_clause', 'coordination', 'correlative', 'so_that']],
  ['非谓语动词', ['infinitive', 'too_to', 'gerund', 'participle', 'formal_subject']],
  ['比较', ['comparative', 'superlative', 'as_as']],
  ['词形', ['contraction', 'possessive']]
];

function isIng(w) { return !!w && w.length > 4 && /[a-z]{2,}ing$/.test(w) && !ING_NOT.has(w); }
function isPP(w) {
  if (!w) return false;
  if (w in PP) return true;
  return w.length > 3 && /[a-z]{2,}ed$/.test(w) && !ED_NOT.has(w);
}
function isRealPP(w) { return isPP(w) && PP[w] !== w; }

// ---------- 词形还原（供查词用） ----------
function lemmaCandidates(raw) {
  const w = String(raw || '').toLowerCase().replace(/[’‘]/g, "'").replace(/^[^a-z]+|[^a-z]+$/g, '');
  const out = [];
  const add = (x, note, r) => { if (x && /^[a-z][a-z'-]*$/.test(x) && !out.some(o => o.w === x)) out.push({ w: x, note: note || '', r: !!r }); };
  if (!w) return out;
  add(w, '');
  let m;
  if (w === "won't") add('will', "won't = will not");
  else if (w === "can't") add('can', "can't = cannot");
  else if (w === "let's") add('let', "let's = let us");
  else if ((m = w.match(/^([a-z]+)n't$/))) add(m[1], w + ' = ' + m[1] + ' not');
  else if ((m = w.match(/^([a-z]+)'(m|re|ll|ve|d|s)$/))) {
    const map = { m: 'am', re: 'are', ll: 'will', ve: 'have', d: 'would 或 had', s: 'is／has，或表示所有格"……的"' };
    add(m[1], w + ' = ' + m[1] + ' + ' + map[m[2]]);
  }
  if (w.indexOf("'") >= 0) return out;
  const pb = PAST[w], ppb = PP[w];
  if (pb && pb !== w) add(pb, w + ' 是 ' + pb + ' 的过去式' + (ppb === pb ? '／过去分词' : ''));
  if (ppb && ppb !== w) add(ppb, w + ' 是 ' + ppb + ' 的过去分词');
  const IRR_PL = { children: 'child', men: 'man', women: 'woman', feet: 'foot', teeth: 'tooth', mice: 'mouse', geese: 'goose', people: 'person', knives: 'knife', wives: 'wife', lives: 'life', leaves: 'leaf', wolves: 'wolf', halves: 'half', shelves: 'shelf', thieves: 'thief' };
  if (IRR_PL[w]) add(IRR_PL[w], w + ' 是 ' + IRR_PL[w] + ' 的复数');
  const SPECIAL = { has: 'have', does: 'do', is: 'be', am: 'be', are: 'be', better: 'good', best: 'good', worse: 'bad', worst: 'bad' };
  if (SPECIAL[w]) add(SPECIAL[w], w + ' 的原形是 ' + SPECIAL[w]);
  const rule = (stem, note) => add(stem, w + ' → ' + stem + '（' + note + '）', true);
  const dbl = b => /([b-df-hj-np-tv-z])\1$/.test(b);
  if (/ies$/.test(w) && w.length > 4) rule(w.slice(0, -3) + 'y', '复数／第三人称单数');
  if (/(ses|xes|zes|ches|shes|oes)$/.test(w)) rule(w.slice(0, -2), '复数／第三人称单数');
  if (/[^s]s$/.test(w) && w.length > 3) rule(w.slice(0, -1), '复数／第三人称单数');
  if (/ied$/.test(w) && w.length > 4) rule(w.slice(0, -3) + 'y', '过去式／过去分词');
  if (/ed$/.test(w) && w.length > 4) { const b = w.slice(0, -2); rule(b, '过去式／过去分词'); rule(w.slice(0, -1), '过去式／过去分词'); if (dbl(b)) rule(b.slice(0, -1), '过去式／过去分词'); }
  if (/ying$/.test(w) && w.length > 5) rule(w.slice(0, -4) + 'ie', '-ing 形式');
  if (/ing$/.test(w) && w.length > 5) { const b = w.slice(0, -3); rule(b, '-ing 形式'); rule(b + 'e', '-ing 形式'); if (dbl(b)) rule(b.slice(0, -1), '-ing 形式'); }
  if (/ier$/.test(w)) rule(w.slice(0, -3) + 'y', '比较级');
  if (/iest$/.test(w)) rule(w.slice(0, -4) + 'y', '最高级');
  if (/er$/.test(w) && w.length > 4) { const b = w.slice(0, -2); rule(b, '比较级或 -er 名词'); rule(w.slice(0, -1), '比较级'); if (dbl(b)) rule(b.slice(0, -1), '比较级'); }
  if (/est$/.test(w) && w.length > 5) { const b = w.slice(0, -3); rule(b, '最高级'); rule(w.slice(0, -2), '最高级'); if (dbl(b)) rule(b.slice(0, -1), '最高级'); }
  if (/ily$/.test(w)) rule(w.slice(0, -3) + 'y', '副词');
  else if (/ly$/.test(w) && w.length > 4) rule(w.slice(0, -2), '副词');
  return out;
}

// ---------- 句子分析 ----------
function tokenize(s) {
  return String(s).replace(/[’‘]/g, "'").match(/[A-Za-z]+(?:'[A-Za-z]+)*|\d+(?:[.,]\d+)*|[^\sA-Za-z\d]/g) || [];
}

function expand(orig) {
  const ws = [], contr = [];
  for (const o of orig) {
    const lw = o.toLowerCase();
    if (!/^[a-z]/.test(lw)) { ws.push({ w: lw, o: o, p: true }); continue; }
    const push = (...arr) => arr.forEach(w => ws.push({ w: w, o: o }));
    let m;
    if (lw === "won't") { push('will', 'not'); contr.push(o); continue; }
    if (lw === "can't") { push('can', 'not'); contr.push(o); continue; }
    if (lw === 'cannot') { push('can', 'not'); continue; }
    if (lw === "shan't") { push('shall', 'not'); contr.push(o); continue; }
    if (lw === "let's") { push('let', 'us'); contr.push(o); continue; }
    if ((m = lw.match(/^([a-z]+)n't$/))) { push(m[1], 'not'); contr.push(o); continue; }
    if ((m = lw.match(/^([a-z]+)'(m|re|ll|ve)$/))) { push(m[1], { m: 'am', re: 'are', ll: 'will', ve: 'have' }[m[2]]); contr.push(o); continue; }
    if ((m = lw.match(/^([a-z]+)'d$/))) { ws.push({ w: m[1], o: o }); ws.push({ w: 'would', o: o, dAmb: true }); contr.push(o); continue; }
    if ((m = lw.match(/^([a-z]+)'s$/))) {
      if (PRON_S.has(m[1])) { ws.push({ w: m[1], o: o }); ws.push({ w: 'is', o: o, sAmb: true }); contr.push(o); }
      else ws.push({ w: m[1], o: o, poss: true });
      continue;
    }
    ws.push({ w: lw, o: o });
  }
  for (let i = 0; i < ws.length; i++) {
    const t = ws[i];
    if (!t.dAmb && !t.sAmb) continue;
    let j = i + 1; while (j < ws.length && SKIP.has(ws[j].w)) j++;
    const n = ws[j] ? ws[j].w : '';
    if (t.dAmb && (n === 'better' || isRealPP(n))) t.w = 'had';
    if (t.sAmb && (n === 'been' || n === 'got' || (n in PP && PP[n] !== n && !(n in PAST)))) t.w = 'has';
  }
  return { ws: ws, contr: contr };
}

function analyze(sentence) {
  const { ws, contr } = expand(tokenize(sentence));
  const items = [], keys = new Set(), used = new Set();
  const W = i => (ws[i] && !ws[i].p) ? ws[i].w : '';
  const nx = i => { let j = i + 1; while (j < ws.length && !ws[j].p && SKIP.has(ws[j].w)) j++; return j; };
  const pv = i => { let j = i - 1; while (j >= 0 && !ws[j].p && SKIP.has(ws[j].w)) j--; return W(j); };
  const hit = (a, b) => {
    const s = []; let last = null;
    for (let k = Math.max(0, a); k <= b && k < ws.length; k++) { if (ws[k].o !== last) { s.push(ws[k].o); last = ws[k].o; } }
    return s.join(' ').replace(/\s+([,.!?;:])/g, '$1');
  };
  const add = (key, title, detail, h) => {
    const id = key + '|' + (title || '');
    if (keys.has(id)) return;
    keys.add(id);
    const r = REF[key];
    items.push({ key: key, title: title || (r ? r.t : key), detail: detail || (r ? r.f : ''), hit: h || '' });
  };
  const mark = (...a) => a.forEach(k => used.add(k));
  const hasQ = /\?/.test(sentence);
  const hasEx = /!/.test(sentence);
  const L = ' ' + ws.filter(t => !t.p).map(t => t.w).join(' ') + ' ';
  const hasBy = / by /.test(L);
  let tense = false, subCount = 0, coordCount = 0;
  const T = () => { tense = true; };
  const DETNOUN = set('the a an his her my your their our its free good own');

  for (let i = 0; i < ws.length; i++) {
    const t = ws[i];
    if (t.p || used.has(i)) continue;
    const w = t.w, prev = pv(i);

    if (w === 'will' || w === 'shall') {
      if (DETNOUN.has(W(i - 1))) continue;
      let j = nx(i); if (hasQ && SUBJ.has(W(j))) j = nx(j);
      const n = W(j);
      if (!n) continue;
      if (n === 'have') {
        const k = nx(j), n2 = W(k);
        if (n2 === 'been' && isIng(W(nx(k)))) { add('perfect_continuous', '将来完成进行时', 'will have been + 动词-ing', hit(i, nx(k))); mark(i, j, k, nx(k)); T(); continue; }
        if (isPP(n2)) { add('future_perfect', null, null, hit(i, k)); mark(i, j, k); T(); continue; }
      }
      if (n === 'be') {
        const k = nx(j), n2 = W(k);
        if (isIng(n2) && !ADJ_ING.has(n2)) { add('future_continuous', null, null, hit(i, k)); mark(i, j, k); T(); continue; }
        if (isPP(n2) && !ADJ_ED.has(n2)) { add('simple_future', null, null, hit(i, k)); add('passive', '被动语态（一般将来时）', 'will be + 过去分词', hit(i, k)); mark(i, j, k); T(); continue; }
        add('simple_future', null, null, hit(i, k)); mark(i, j); T(); continue;
      }
      add('simple_future', null, null, hit(i, j)); mark(i, j); T(); continue;
    }

    if (MODALS.has(w)) {
      if (DETNOUN.has(W(i - 1))) continue;
      if (w === 'may' && i > 0 && /^[A-Z]/.test(t.o)) continue;
      if (w === 'ought') { add('modal', '情态动词 ought to', MODAL_MEAN.ought, hit(i, i + 2)); mark(i); T(); continue; }
      let j = nx(i); if (hasQ && SUBJ.has(W(j))) j = nx(j);
      const n = W(j);
      if (n === 'have' && isPP(W(nx(j)))) { const k = nx(j); add('modal_perfect', null, null, hit(i, k)); mark(i, j, k); T(); continue; }
      add('modal', '情态动词 ' + w, MODAL_MEAN[w], hit(i, j)); mark(i); T();
      if (n === 'be') {
        const k = nx(j), n2 = W(k);
        if (isPP(n2) && !ADJ_ED.has(n2)) { add('passive', '被动语态（情态动词 + be + 过去分词）', '情态动词 + be + 过去分词', hit(i, k)); mark(k); }
        else if (isIng(n2) && !ADJ_ING.has(n2)) { add('present_continuous', '进行体（情态动词 + be + -ing）', '情态动词 + be + 动词-ing，表示对正在进行的动作的推测等', hit(i, k)); mark(k); }
      }
      if (j < ws.length && !ws[j].p) mark(j);
      continue;
    }

    if (w === 'am' || w === 'is' || w === 'are' || w === 'was' || w === 'were') {
      const pres = (w === 'am' || w === 'is' || w === 'are');
      let j = nx(i); if (hasQ && (SUBJ.has(W(j)) || W(j) === 'there')) j = nx(j);
      const n = W(j);
      if (n === 'going' && W(j + 1) === 'to' && W(j + 2) && !DET_ONLY.has(W(j + 2))) {
        add('be_going_to', pres ? '一般将来时（be going to）' : '过去将来时（was/were going to）', null, hit(i, j + 2)); mark(i, j, j + 1, j + 2); T(); continue;
      }
      if (n === 'being' && isPP(W(nx(j)))) {
        const k = nx(j);
        add(pres ? 'present_continuous' : 'past_continuous', null, null, hit(i, k));
        add('passive', '被动语态（进行时）', 'am/is/are/was/were + being + 过去分词', hit(i, k)); mark(i, j, k); T(); continue;
      }
      if (isIng(n) && !ADJ_ING.has(n)) { add(pres ? 'present_continuous' : 'past_continuous', null, null, hit(i, j)); mark(i, j); T(); continue; }
      if (isPP(n) && !ADJ_ED.has(n)) {
        add(pres ? 'simple_present' : 'simple_past', null, null, hit(i, i));
        add('passive', pres ? '被动语态（一般现在时）' : '被动语态（一般过去时）', (pres ? 'am/is/are' : 'was/were') + ' + 过去分词' + (hasBy ? '，by 引出动作执行者' : ''), hit(i, j));
        mark(i, j); T(); continue;
      }
      add(pres ? 'simple_present' : 'simple_past', null, null, hit(i, i));
      const adjNote = (ADJ_ED.has(n) || ADJ_ING.has(n)) ? ('系动词 be + 形容词：' + n + ' 在这里作形容词，描述主语的状态或特征') : null;
      if (n !== 'used') add('be_linking', null, adjNote, hit(i, j));
      mark(i); T(); continue;
    }

    if (w === 'have' || w === 'has' || w === 'had') {
      if (prev === 'to' || prev === 'do' || prev === 'does' || prev === 'did' || MODALS.has(prev)) { mark(i); continue; }
      let j = nx(i); if (hasQ && SUBJ.has(W(j))) j = nx(j);
      const n = W(j), past = (w === 'had');
      const perfKey = past ? 'past_perfect' : 'present_perfect';
      if (n === 'been') {
        const k = nx(j), n2 = W(k);
        if (isIng(n2) && !ADJ_ING.has(n2)) { add('perfect_continuous', past ? '过去完成进行时' : '现在完成进行时', null, hit(i, k)); mark(i, j, k); T(); continue; }
        add(perfKey, null, null, hit(i, j));
        if (isPP(n2) && !ADJ_ED.has(n2)) { add('passive', past ? '被动语态（过去完成时）' : '被动语态（现在完成时）', (past ? 'had' : 'have/has') + ' been + 过去分词', hit(i, k)); mark(k); }
        mark(i, j); T(); continue;
      }
      if (n === 'to') { add('have_to', null, null, hit(i, j + 1)); add(past ? 'simple_past' : 'simple_present', null, null, hit(i, i)); mark(i, j); T(); continue; }
      if (past && n === 'better') { add('modal', 'had better（最好……）', 'had better + 动词原形：表示"最好做某事"，带有建议或警告的语气', hit(i, j + 1)); mark(i, j); T(); continue; }
      if (isPP(n)) { add(perfKey, null, null, hit(i, j)); mark(i, j); T(); continue; }
      add(past ? 'simple_past' : 'simple_present', null, null, hit(i, i)); mark(i); T(); continue;
    }

    if (w === 'do' || w === 'does' || w === 'did') {
      const pastD = (w === 'did');
      if (prev === 'to' || MODALS.has(prev)) { mark(i); continue; }
      if (W(i + 1) === 'not' || (hasQ && SUBJ.has(W(i + 1)))) {
        add('do_aux', null, null, hit(i, Math.min(nx(i + 1), ws.length - 1)));
        add(pastD ? 'simple_past' : 'simple_present', null, null, hit(i, i)); mark(i); T(); continue;
      }
      add(pastD ? 'simple_past' : 'simple_present', null, null, hit(i, i)); mark(i); T(); continue;
    }

    const blocked = BLOCK_PREV.has(prev) || MODALS.has(prev) || BE_ALL.has(prev);
    if (!blocked && i > 0) {
      if (w in PAST && PAST[w] !== w) { add('simple_past', null, null, hit(i, i)); mark(i); T(); continue; }
      if (/[a-z]{2,}ed$/.test(w) && w.length > 4 && !ED_NOT.has(w) && !ADJ_ED.has(w)) { add('simple_past', null, null, hit(i, i)); mark(i); T(); continue; }
    }
  }

  if (!tense) {
    for (let i = 0; i < ws.length; i++) {
      const s = W(i);
      if (!SUBJ.has(s)) continue;
      const j = nx(i), n = W(j);
      if (!n || DET_ONLY.has(n) || SUBJ.has(n)) continue;
      if ((['he', 'she', 'it'].includes(s) && /s$/.test(n)) || ['i', 'you', 'we', 'they'].includes(s)) {
        add('simple_present', null, null, hit(i, j)); T(); break;
      }
    }
  }
  if (!tense) add('sentence_types', '未识别出明确的谓语时态', '可能是省略句、名词短语或对话片段，也可能是自动分析没有识别出来。', '');

  // there be
  let m = L.match(/ there (is|are|was|were|will be|has been|have been|had been|used to be|seems to be|seemed to be) /);
  if (m) add('there_be', null, null, 'there ' + m[1]);

  // 条件 / 虚拟
  for (let i = 0; i < ws.length; i++) {
    const w = W(i);
    if (w !== 'if' && w !== 'unless') continue;
    if (w === 'if' && W(i + 1) === 'only') { add('subjunctive', '虚拟语气（if only：要是……就好了）', null, hit(i, i + 4)); subCount++; continue; }
    if (w === 'if' && OBJ_V.has(pv(i))) { add('object_clause', '宾语从句（if 表示"是否"）', '动词 + if/whether + 从句：if 在这里意为"是否"，不是"如果"', hit(i, i + 3)); subCount++; continue; }
    const subj = /\b(would|could|might)\b/.test(L) && (/ if [^,]*\b(were|had)\b/.test(L) || / if [a-z ]*\b(\w+ed|went|came|knew|had|were|could|did)\b/.test(L));
    if (w === 'if' && subj) add('subjunctive', '虚拟语气（与事实相反的假设）', null, hit(i, i + 4));
    else add('conditional', w === 'unless' ? '条件状语从句（unless：除非）' : '条件状语从句（if：如果）', null, hit(i, i + 4));
    subCount++;
  }
  m = L.match(/ wish(es|ed)? (i|you|he|she|it|we|they|that) (were|had|could|would|knew|was|did)\b/);
  if (m) { add('subjunctive', '虚拟语气（wish 后的从句）', 'wish + 从句：常用过去式（be 多用 were）表示与现在事实相反的愿望', m[0].trim()); subCount++; }

  // 从句
  const first = ws.findIndex(t => !t.p);
  for (let i = 0; i < ws.length; i++) {
    const w = W(i);
    if (!w || i === first) continue;
    const prev = pv(i);
    if (w === 'who' || w === 'whom' || w === 'whose' || w === 'which') {
      if (OBJ_V.has(prev)) add('object_clause', '宾语从句（' + w + ' 引导）', null, hit(i, i + 3));
      else add('relative_clause', '定语从句（' + w + ' 引导）', w === 'whose' ? 'whose + 名词：表示"……的"' : (w === 'who' || w === 'whom' ? w + ' 指代前面的人' : 'which 指代前面的物或整件事'), hit(i - 1, i + 3));
      subCount++;
    } else if (w === 'that') {
      if (prev === 'so' || prev === 'such' || W(i - 2) === 'so' || W(i - 2) === 'such' || W(i - 3) === 'such' || W(i - 3) === 'so') continue;
      const n = W(i + 1);
      if (OBJ_V.has(prev)) { add('object_clause', '宾语从句（that 引导）', 'that 引导宾语从句，本身没有意思，口语中常省略', hit(i - 1, i + 3)); subCount++; }
      else if (n && (SUBJ.has(n) || DET_ONLY.has(n) && n !== 'that' || MODALS.has(n) || BE_ALL.has(n) || n === 'there' || n === 'had' || n === 'has' || n === 'have') && !DET_ONLY.has(prev) && !BE_ALL.has(prev)) {
        add('relative_clause', '定语从句（that 引导）', 'that 引导从句修饰前面的名词（有时也可能是同位语从句）', hit(i - 1, i + 3)); subCount++;
      }
    } else if (w === 'what' && !(hasEx && i === first + 0)) {
      add('noun_clause', null, null, hit(i, i + 3)); subCount++;
    } else if ((w === 'where' || w === 'why' || w === 'how' || w === 'whether') && OBJ_V.has(prev)) {
      add('object_clause', '宾语从句（' + w + ' 引导）', '从句用陈述句语序', hit(i, i + 3)); subCount++;
    } else if (w === 'where' && prev && !OBJ_V.has(prev)) {
      add('relative_clause', '定语从句（where 引导）', 'where 引导从句修饰表示地点的名词', hit(i - 1, i + 3)); subCount++;
    }
  }

  // 状语从句
  const multi = ['as soon as', 'even though', 'even if', 'so that', 'as if', 'as though', 'now that', 'in case'];
  multi.forEach(c => {
    if (L.indexOf(' ' + c + ' ') >= 0) { add('adverbial_clause', '状语从句 · ' + ADV_CONJ[c], c + ' 引导状语从句', c); subCount++; }
  });
  for (let i = 0; i < ws.length; i++) {
    const w = W(i);
    if (!(w in ADV_CONJ) || w.indexOf(' ') >= 0) continue;
    if ((w === 'though') && !W(i + 1)) continue;
    if (w === 'when' && hasQ && i === first) continue;
    if (w === 'while' && (W(i - 1) === 'a' || W(i - 1) === 'the')) continue;
    if (w === 'once' && i !== first && !SUBJ.has(W(i + 1))) continue;
    if (NEED_SUBJ_CONJ.has(w)) {
      const n = W(nx(i));
      if (!(SUBJ.has(n) || n === 'there' || (ws[nx(i)] && /^[A-Z]/.test(ws[nx(i)].o) && n !== 'i'))) continue;
    }
    if (w === 'since' && L.indexOf(' ever since ') >= 0) { /* still a clause */ }
    add('adverbial_clause', '状语从句 · ' + ADV_CONJ[w], w + ' 引导状语从句', hit(i, i + 3)); subCount++;
  }
  if (L.indexOf(' in order to ') >= 0) add('infinitive', '不定式作目的状语（in order to）', 'in order to + 动词原形：为了……', 'in order to');

  // 并列
  const CO = { and: '并列／顺承', but: '转折', or: '选择／否则', so: '结果', yet: '转折' };
  for (let i = 1; i < ws.length; i++) {
    const w = W(i);
    if (!(w in CO)) continue;
    const n = W(nx(i));
    if (w === 'so' && (/^[a-z]+$/.test(n) && !SUBJ.has(n) && n !== 'there')) continue;
    const afterComma = ws[i - 1] && ws[i - 1].w === ',' && w !== 'and';
    if (SUBJ.has(n) || n === 'there' || afterComma || (n && ws[nx(i)] && /^[A-Z]/.test(ws[nx(i)].o) && ws[i - 1] && ws[i - 1].p)) {
      add('coordination', '并列句（' + w + '：' + CO[w] + '）', null, hit(i - 1, i + 2)); coordCount++;
    }
  }
  if (/ not only .* but /.test(L)) add('correlative', 'not only … but (also)：不但……而且', null, 'not only … but');
  if (/ either .* or /.test(L)) add('correlative', 'either … or：或者……或者', null, 'either … or');
  if (/ neither .* nor /.test(L)) add('correlative', 'neither … nor：既不……也不', null, 'neither … nor');
  if (/ both .* and /.test(L)) add('correlative', 'both … and：两者都', null, 'both … and');
  m = L.match(/ (so [a-z]+(?: [a-z]+)? that|such (?:a |an )?[a-z]+(?: [a-z]+)? that) /);
  if (m) { add('so_that', null, null, m[1]); subCount++; }

  // 非谓语
  m = L.match(/ too [a-z]+ to [a-z]+/);
  if (m) add('too_to', null, null, m[0].trim());
  m = L.match(/ (be|am|is|are|was|were|been|get|got|getting|become|became) used to /);
  if (m) add('used_to', 'be/get used to（习惯于）', 'be/get used to + 名词或动名词：习惯于……', m[0].trim());
  else if ((m = L.match(/ used to [a-z]+/))) add('used_to', 'used to（过去常常）', 'used to + 动词原形：过去常常做（现在不做了）', m[0].trim());
  for (let i = 0; i < ws.length - 1; i++) {
    if (W(i) !== 'to') continue;
    const j = i + 1, n = W(j);
    if (!n || DET_TO.has(n) || /ing$/.test(n) || /^[A-Z]/.test(ws[j].o) || /^\d/.test(n)) continue;
    const p = W(i - 1);
    if (p === 'forward' || p === 'order' || (p === 'used' && BE_ALL.has(W(i - 2)))) continue;
    add('infinitive', '动词不定式（to ' + n + '）', 'to + 动词原形；若 ' + n + ' 是名词，则 to 为介词"到、向"', hit(i, j));
    break;
  }
  m = L.match(/^ it (is|was|seems|seemed|will be|would be)( not)? (?!a |an |the )[a-z]+( [a-z]+)? (to|that|for) /);
  if (m) add('formal_subject', null, null, m[0].trim());

  if (first >= 0) {
    const fw = W(first);
    const commaSoon = ws.slice(first, first + 8).some(t => t.w === ',');
    if (isIng(fw) && !ADJ_ING.has(fw)) {
      if (commaSoon) add('participle', '现在分词短语作状语', '句首的 -ing 短语 + 逗号：表示伴随、时间或原因，逻辑主语是主句的主语', hit(first, first + 3));
      else add('gerund', '动名词作主语', '句首的 -ing 形式作主语：……这件事', hit(first, first + 3));
    } else if (isRealPP(fw) && commaSoon && !BE_ALL.has(fw)) {
      add('participle', '过去分词短语作状语', '句首的过去分词短语 + 逗号：表示状态、原因或被动意义', hit(first, first + 3));
    }
  }
  for (let i = 1; i < ws.length; i++) {
    const w = W(i);
    if (!isIng(w) || used.has(i) || ADJ_ING.has(w)) continue;
    if (ws[i - 1] && ws[i - 1].w === ',') { add('participle', '现在分词短语（伴随状语）', ', + 动词-ing ……：表示同时发生的伴随动作', hit(i - 1, i + 2)); continue; }
    const p = W(i - 1);
    if (PREP.has(p)) add('gerund', '动名词作介词宾语（' + p + ' + -ing）', '介词后面的动词要用 -ing 形式', hit(i - 1, i));
    else if (GER_V.has(p)) add('gerund', '动名词作宾语（' + p + ' + -ing）', p + ' 后面接动词 -ing 形式', hit(i - 1, i));
  }

  // 比较
  for (let i = 1; i < ws.length; i++) {
    if (W(i) === 'than') { add('comparative', null, null, hit(i - 2, i + 1)); break; }
  }
  m = L.match(/ as [a-z]+(?: [a-z]+)? as /);
  if (m && !/ as well as | as soon as | as long as | as far as /.test(m[0])) add('as_as', null, null, m[0].trim());
  m = L.match(/ the (most|least) [a-z]+/) || L.match(/ the (best|worst) /);
  if (!m) { const m2 = L.match(/ the ([a-z]{3,}est) /); if (m2 && !EST_NOT.has(m2[1])) m = m2; }
  if (m) add('superlative', null, null, m[0].trim());

  // 否定
  for (let i = 0; i < ws.length; i++) { if (NEG.has(W(i))) { add('negation', null, null, hit(Math.max(0, i - 1), i + 1)); break; } }

  // 句型
  let mood = '陈述句';
  const fw = first >= 0 ? W(first) : '';
  const low = String(sentence).toLowerCase().replace(/[’‘]/g, "'");
  if (hasQ) {
    mood = '疑问句';
    if (/,\s*(is|are|was|were|do|does|did|have|has|had|can|could|will|would|should|shall|must|won't|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|haven't|hasn't|hadn't|can't|couldn't|wouldn't|shouldn't|mustn't)\s+(i|you|he|she|it|we|they|there)\s*\?/.test(low)) add('tag_question', null, null, '');
    else if (WH.has(fw)) add('wh_question', null, null, hit(first, first + 2));
    else if (AUX_Q.has(fw)) add('yes_no_question', null, null, hit(first, first + 2));
    else add('yes_no_question', '疑问语气（陈述语序 + 问号）', '口语中常直接在陈述句末加问号表示疑问', '');
  } else if (hasEx && (fw === 'what' || fw === 'how')) {
    mood = '感叹句'; add('exclamation', null, null, hit(first, first + 3));
  } else if (first >= 0 && (IMP.has(fw) || (fw === 'do' && W(first + 1) === 'not')) && !SUBJ.has(W(first + 1)) && W(first + 1) !== 'you') {
    mood = '祈使句'; add('imperative', null, null, hit(first, first + 2));
  } else if (hasEx) {
    add('exclamation', '感叹语气', '句末用感叹号，表达强烈情绪（惊讶、激动、命令等）', '');
  }
  if (/["“”]/.test(sentence)) add('direct_speech', null, null, '');
  const poss = ws.filter(t => t.poss);
  if (poss.length) add('possessive', null, null, poss.map(t => t.o).join('、'));
  if (contr.length) {
    const uniq = [...new Set(contr)];
    const detail = uniq.map(o => o + ' = ' + ws.filter(t => t.o === o).map(t => t.w).join(' ')).join('；');
    add('contraction', null, detail, uniq.join('、'));
  }

  let finalItems = items;
  if (keys.has('subjunctive|虚拟语气（与事实相反的假设）')) finalItems = finalItems.filter(it => !(it.key === 'simple_past' && /^were$/i.test(it.hit)));
  if (mood === '祈使句' || mood === '感叹句') finalItems = finalItems.filter(it => it.title !== '未识别出明确的谓语时态');
  const struct = subCount && coordCount ? '并列复合句' : subCount ? '复合句（主句 + 从句）' : coordCount ? '并列句' : '简单句';
  return { summary: mood + '，' + struct, items: finalItems };
}

root.EG = { analyze: analyze, lemmaCandidates: lemmaCandidates, REF: REF, GROUPS: GROUPS, PAST: PAST, PP: PP };
})(typeof window !== 'undefined' ? window : globalThis);
