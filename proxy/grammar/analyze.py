# 一句一读 · 句子结构分析（spaCy 依存句法 → 中文讲解）
# 输出：主干（主谓宾/主系表…）、每个词属于哪个成分（给句子上色）、从句、非谓语短语、特殊句式、时态语态
import re

MARKS = {
    'when': ('时间', '当……时'), 'while': ('时间', '当……时 / 而'), 'as': ('时间或原因', '当……时 / 因为 / 正如'), 'before': ('时间', '在……之前'),
    'after': ('时间', '在……之后'), 'until': ('时间', '直到……'), 'till': ('时间', '直到……'), 'since': ('时间或原因', '自从 / 既然'), 'once': ('时间或条件', '一旦'),
    'because': ('原因', '因为'), 'if': ('条件', '如果'), 'unless': ('条件', '除非'), 'although': ('让步', '虽然'), 'though': ('让步', '虽然'),
    'whether': ('让步或条件', '无论是否'), 'so': ('结果或目的', '所以 / 以便'), 'than': ('比较', '比'), 'where': ('地点', '在……的地方'), 'whenever': ('时间', '每当'),
    'wherever': ('地点', '无论哪里'), 'lest': ('目的', '以免'), 'whereas': ('对比', '然而'), 'like': ('方式', '像……一样'),
}
APPOS_NOUNS = {'fact', 'news', 'idea', 'thought', 'belief', 'hope', 'reason', 'possibility', 'question', 'doubt', 'feeling', 'promise', 'truth', 'chance', 'evidence', 'suggestion', 'information', 'rumor', 'rumour', 'sense'}
COMPLEX_V = {'make', 'keep', 'find', 'let', 'have', 'get', 'leave', 'consider', 'think', 'see', 'hear', 'watch', 'feel', 'call', 'name', 'elect', 'paint'}
WH = {'what', 'who', 'whom', 'whose', 'which', 'when', 'where', 'why', 'how', 'whether', 'if', 'that', 'whatever', 'whoever', 'whichever'}
ROLE_CN = {'S': '主语', 'V': '谓语', 'O': '宾语', 'IO': '间接宾语', 'C': '表语', 'OC': '宾语补足语', 'A': '状语', 'X': ''}

def span_text(toks):
    out = ''
    for t in toks:
        out += t.text + t.whitespace_
    return out.strip()

def subtree(t):
    return sorted(t.subtree, key=lambda x: x.i)

def verb_group(v):
    """谓语动词连同助动词、否定、小品词"""
    g = [v] + [c for c in v.children if c.dep_ in ('aux', 'auxpass', 'neg', 'prt')]
    return sorted(g, key=lambda x: x.i)

def tense_of(v):
    auxs = [c for c in v.children if c.dep_ in ('aux', 'auxpass')]
    words = [a.text.lower() for a in sorted(auxs, key=lambda x: x.i)]
    passive = any(c.dep_ in ('auxpass', 'nsubjpass') for c in v.children)
    tag = v.tag_
    modal = next((a for a in auxs if a.tag_ == 'MD'), None)
    w = ' '.join(words)
    is_ing = tag == 'VBG'
    if v.pos_ == 'AUX' and v.dep_ == 'ROOT':      # be 作谓语本身
        tag = v.tag_
    name = None
    if modal is not None:
        m = modal.text.lower()
        if m in ('will', "'ll", 'shall'):
            if 'have' in words: name = '将来完成时'
            elif 'be' in words and is_ing: name = '将来进行时'
            else: name = '一般将来时'
        elif m in ('would',) and 'have' in words: name = '虚拟语气 / 过去将来完成（would have + 过去分词）'
        elif 'have' in words: name = '情态动词 + have + 过去分词（对过去的推测或后悔）'
        else: name = '情态动词 ' + m + ' + 动词原形'
    elif any(x in words for x in ('has', 'have', "'ve")) and 'been' in words and is_ing: name = '现在完成进行时'
    elif any(x in words for x in ('had', "'d")) and 'been' in words and is_ing: name = '过去完成进行时'
    elif any(x in words for x in ('has', 'have', "'ve", "'s")) and (tag == 'VBN' or passive and 'been' in words): name = '现在完成时'
    elif 'had' in words and (tag == 'VBN' or passive): name = '过去完成时'
    elif any(x in words for x in ('am', 'is', 'are', "'m", "'re", "'s")) and is_ing: name = '现在进行时'
    elif any(x in words for x in ('was', 'were')) and is_ing: name = '过去进行时'
    elif any(x in words for x in ('do', 'does')) or tag in ('VBZ', 'VBP'): name = '一般现在时'
    elif 'did' in words or tag == 'VBD': name = '一般过去时'
    elif passive and any(x in words for x in ('was', 'were')): name = '一般过去时'
    elif passive and any(x in words for x in ('am', 'is', 'are')): name = '一般现在时'
    elif tag == 'VB' and not words: name = None
    return name, passive

def clause_info(t):
    """从句 / 非谓语短语的类型和说明"""
    sub = subtree(t)
    text = span_text([x for x in sub if not (x.dep_ == 'punct' and x.i in (sub[0].i, sub[-1].i))])
    first = sub[0]
    mark = next((c for c in t.children if c.dep_ == 'mark'), None)
    whw = next((x for x in sub if x.text.lower() in WH and x.tag_ in ('WDT', 'WP', 'WP$', 'WRB', 'IN')), None)
    lead = (mark or whw)
    lw = lead.text.lower() if lead is not None else ''
    has_subj = any(c.dep_ in ('nsubj', 'nsubjpass', 'expl', 'csubj') for c in t.children) or (whw is not None and whw.dep_ in ('nsubj', 'nsubjpass'))
    finite = has_subj or any(c.dep_ in ('aux', 'auxpass') and c.tag_ in ('MD', 'VBD', 'VBZ', 'VBP') for c in t.children) or t.tag_ in ('VBD', 'VBZ', 'VBP')
    to = any(c.dep_ == 'aux' and c.text.lower() == 'to' for c in t.children)
    d = t.dep_
    head = t.head
    if d == 'relcl':
        rel = lw or '（省略了关系词）'
        note = '修饰前面的「' + head.text + '」，说明是什么样的' + head.text
        if not lead: note += '；关系词 that/which 在从句里作宾语，被省略了'
        return {'type': '定语从句', 'lead': rel, 'text': text, 'note': note, 'k': 'M'}
    if d == 'acl':
        if finite and lw == 'that' and head.lemma_.lower() in APPOS_NOUNS:
            return {'type': '同位语从句', 'lead': 'that', 'text': text, 'note': '解释说明「' + head.text + '」的具体内容（that 不作成分，不能省略）', 'k': 'M'}
        if finite:
            return {'type': '定语从句', 'lead': lw or '（省略）', 'text': text, 'note': '修饰前面的「' + head.text + '」', 'k': 'M'}
        if to: return {'type': '不定式作定语', 'lead': 'to', 'text': text, 'note': '放在「' + head.text + '」后面修饰它：要……的' + head.text, 'k': 'M'}
        if t.tag_ == 'VBG': return {'type': '现在分词短语作定语', 'lead': t.text, 'text': text, 'note': '修饰「' + head.text + '」，表示主动、正在进行：正在……的' + head.text, 'k': 'M'}
        if t.tag_ == 'VBN': return {'type': '过去分词短语作定语', 'lead': t.text, 'text': text, 'note': '修饰「' + head.text + '」，表示被动或完成：被……的' + head.text, 'k': 'M'}
        return None
    if d == 'advcl':
        if finite or mark is not None and lw not in ('to',):
            kind, cn = MARKS.get(lw, ('', ''))
            if lw == 'so' or any(x.text.lower() == 'that' and x.dep_ == 'mark' for x in t.children) and any(x.text.lower() == 'so' for x in sub[:3]):
                kind, cn = '目的或结果', 'so that：以便 / 所以'
            if lw == 'if' and re.search(r'\b(were|had|would|could|might)\b', ' '.join(x.text.lower() for x in t.head.subtree)):
                note = 'if 引导的条件状语从句；主句和从句的动词往过去推了一步，多半是虚拟语气（假设与事实相反）'
            else:
                note = (lw + ' 引导' if lw else '') + (kind + '状语从句' if kind else '状语从句') + ('，意思是“' + cn + '”' if cn else '') + '，修饰主句的谓语「' + head.text + '」'
            return {'type': '状语从句' + (' · ' + kind if kind else ''), 'lead': lw, 'text': text, 'note': note, 'k': 'A'}
        if to: return {'type': '不定式作状语', 'lead': 'to', 'text': text, 'note': '多表示目的：为了……；也可能表示结果', 'k': 'A'}
        if t.tag_ == 'VBG':
            perf = any(c.text.lower() == 'having' for c in t.children)
            return {'type': '现在分词短语作状语', 'lead': 'having' if perf else t.text, 'text': text, 'note': ('having + 过去分词表示“在主句动作之前已经完成”；' if perf else '') + '逻辑主语就是主句的主语，表示时间、原因、伴随等', 'k': 'A'}
        if t.tag_ == 'VBN' and any(c.text.lower() == 'having' for c in t.children):
            return {'type': '现在分词完成式作状语', 'lead': 'having', 'text': text, 'note': 'having + 过去分词：表示这个动作在主句动作之前已经完成（“……之后”），逻辑主语是主句的主语', 'k': 'A'}
        if t.tag_ == 'VBN': return {'type': '过去分词短语作状语', 'lead': t.text, 'text': text, 'note': '表示被动或完成，逻辑主语是主句的主语', 'k': 'A'}
        return {'type': '状语', 'lead': '', 'text': text, 'note': '修饰「' + head.text + '」', 'k': 'A'}
    if d == 'ccomp':
        if re.search(r'["“”]', t.doc.text) and any(x.text in ('"', '“', '”') for x in t.doc[max(0, sub[0].i - 1):sub[0].i + 1]) or re.search(r'["“”]', t.doc.text) and head.lemma_ in ('say', 'ask', 'reply', 'cry', 'shout', 'answer', 'whisper', 'continue', 'add', 'exclaim', 'murmur', 'scream', 'shriek'):
            return {'type': '直接引语（作宾语）', 'lead': '', 'text': text, 'note': '引号里是人物说的原话，整体作「' + head.text + '」的宾语；原话保持自己的语序（问句就是问句语序）', 'k': 'O'}
        if head.lemma_ in COMPLEX_V and not lead and not any(c.dep_ in ('aux', 'auxpass') for c in t.children) and t.tag_ not in ('VBD', 'VBZ', 'VBP'):
            return {'type': '复合宾语（宾语 + 宾语补足语）', 'lead': '', 'text': text, 'note': head.text + ' + 宾语 + 补足语：使/让/觉得……怎么样', 'k': 'O'}
        if head.pos_ == 'AUX' or head.lemma_ == 'be':
            return {'type': '表语从句', 'lead': lw, 'text': text, 'note': '放在系动词 ' + head.text + ' 后面作表语', 'k': 'C'}
        if not lead and not has_subj and t.tag_ in ('VB',):
            return None
        return {'type': '宾语从句', 'lead': lw or '（省略了 that）', 'text': text, 'note': '作「' + head.text + '」的宾语' + ('；that 常可省略' if not lead or lw == 'that' else '') + ('；用陈述语序' if lw in ('what', 'who', 'where', 'when', 'why', 'how', 'whether', 'if', 'which') else ''), 'k': 'O'}
    if d == 'csubj' or d == 'csubjpass':
        return {'type': '主语从句', 'lead': lw, 'text': text, 'note': '整个从句当一个名词用，作句子的主语' + ('；what 在从句里作成分，相当于 the thing(s) that' if lw == 'what' else ''), 'k': 'S'}
    if d == 'pcomp' and finite:
        return {'type': '介词宾语从句', 'lead': lw, 'text': text, 'note': '放在介词「' + head.text + '」后面作宾语', 'k': 'A'}
    if d == 'xcomp':
        if to: return {'type': '不定式作宾语' if head.pos_ == 'VERB' else '不定式', 'lead': 'to', 'text': text, 'note': '「' + head.text + ' to do」：动词后接不定式作宾语或宾补', 'k': 'O'}
        if t.tag_ == 'VBG': return {'type': '动名词 / 现在分词', 'lead': t.text, 'text': text, 'note': '跟在「' + head.text + '」后面', 'k': 'O'}
        return None
    return None

def classify_child(c, root):
    d = c.dep_
    if d == 'expl': return 'X'
    if d in ('nsubj', 'nsubjpass', 'csubj', 'csubjpass'): return 'S'
    if d in ('aux', 'auxpass', 'neg', 'prt'): return 'V'
    if d in ('dobj', 'obj'): return 'O'
    if d == 'dative': return 'IO'
    if d == 'attr' and any(x.dep_ == 'expl' and x.text.lower() == 'there' for x in root.children): return 'S'
    if d in ('attr', 'acomp'): return 'C'
    if d == 'oprd': return 'OC'
    if d == 'ccomp': return 'C' if (root.pos_ == 'AUX' or root.lemma_ == 'be') else 'O'
    if d == 'xcomp':
        if c.pos_ in ('ADJ', 'NOUN', 'PROPN') and (root.lemma_ in ('be', 'seem', 'become', 'look', 'feel', 'sound', 'get', 'turn', 'grow', 'remain', 'stay', 'appear', 'keep')): return 'C'
        return 'O'
    if d in ('advmod', 'advcl', 'prep', 'npadvmod', 'agent', 'pcomp', 'mark'): return 'A'
    if d in ('punct', 'cc', 'conj', 'intj', 'discourse', 'meta', 'dep', 'parataxis'): return 'X'
    return 'A'

def analyze_clause(root, roles):
    """一个分句（主句或并列分句）的主干"""
    vg = verb_group(root)
    for t in vg: roles[t.i] = 'V'
    parts = {'S': [], 'V': [t for t in vg], 'O': [], 'IO': [], 'C': [], 'OC': [], 'A': []}
    if root.pos_ == 'AUX' and root.dep_ in ('ROOT', 'conj'): pass
    for c in root.children:
        if c in vg: continue
        if c.dep_ == 'conj' and any(x.dep_ in ('nsubj', 'nsubjpass', 'expl') for x in c.children): continue   # 并列分句另算
        r = classify_child(c, root)
        if c.dep_ == 'conj' and c.pos_ in ('VERB', 'AUX'):   # 并列谓语：he came and saw
            for t in verb_group(c): roles[t.i] = 'V'
            for cc in c.children:
                if cc.dep_ in ('aux', 'auxpass', 'neg', 'prt'): continue
                rr = classify_child(cc, c)
                for t in subtree(cc): roles.setdefault(t.i, rr)
                if rr in parts: parts[rr].append(cc)
            parts['V'].append(c)
            continue
        if c.dep_ == 'cc' and c.head == root: roles[c.i] = 'X'; continue
        for t in subtree(c): roles.setdefault(t.i, r)
        if r in parts: parts[r].append(c)
    return parts

def pattern_of(parts, root):
    has = {k: bool(v) for k, v in parts.items()}
    if any(c.dep_ == 'expl' and c.text.lower() == 'there' for c in root.children): return 'There be 句型：There + be + 主语（某物）+ 地点'
    if any(c.dep_ in ('auxpass', 'nsubjpass') for c in root.children): return '被动语态：主语 + be + 过去分词' + (' + by 动作执行者' if any(c.dep_ == 'agent' for c in root.children) else '')
    if has['C'] and (root.lemma_ == 'be' or root.pos_ == 'AUX' or root.lemma_ in ('seem', 'become', 'look', 'feel', 'sound', 'get', 'turn', 'grow', 'remain', 'stay', 'appear', 'keep')): return '主语 + 系动词 + 表语（主系表）'
    if has['IO'] and has['O']: return '主语 + 谓语 + 间接宾语 + 直接宾语（主谓双宾）'
    if has['O'] and has['OC']: return '主语 + 谓语 + 宾语 + 宾语补足语'
    if has['O']: return '主语 + 谓语 + 宾语（主谓宾）'
    if not has['S']: return '祈使句（省略了主语 you）' if root.tag_ == 'VB' else '谓语 + ……'
    return '主语 + 谓语（主谓）'

def core_text(parts, key):
    toks = parts.get(key) or []
    if key == 'V': return span_text(sorted(toks, key=lambda x: x.i))
    if not toks: return ''
    out = []
    for c in toks:
        st = subtree(c)
        out.append(span_text(st))
    return ' / '.join(out)

def short_head(parts, key):
    """主干的核心词（去掉修饰）"""
    toks = parts.get(key) or []
    out = []
    for c in toks:
        if c.dep_ in ('ccomp', 'csubj', 'csubjpass', 'xcomp', 'pcomp'):
            st = [x for x in subtree(c) if not x.is_punct]; txt = span_text(st)
            out.append(txt if len(st) <= 7 else span_text(st[:4]) + ' …'); continue
        keep = [c] + [x for x in c.children if x.dep_ in ('det', 'poss', 'compound', 'prt', 'neg', 'case') and x.i < c.i + 3]
        out.append(span_text(sorted(keep, key=lambda x: x.i)))
    return ' / '.join(out)

def analyze(nlp, sentence):
    doc = nlp(sentence)
    sents = list(doc.sents)
    roots = [s.root for s in sents]
    root = roots[0]
    if len(sents) > 1:      # spaCy 偶尔把引号里的话切成两句：取最长的那个当主句
        root = max(roots, key=lambda r: len(list(r.subtree)))
    roles = {}
    main = analyze_clause(root, roles)
    clauses_main = [{'parts': main, 'root': root}]
    for c in root.children:
        if c.dep_ == 'conj' and any(x.dep_ in ('nsubj', 'nsubjpass', 'expl') for x in c.children):
            p = analyze_clause(c, roles); clauses_main.append({'parts': p, 'root': c})
            cc = next((x for x in root.children if x.dep_ == 'cc'), None) or next((x for x in c.children if x.dep_ == 'cc'), None)
            if cc is not None: roles[cc.i] = 'X'
    for t in doc:
        if t.is_punct: roles[t.i] = 'X'
        roles.setdefault(t.i, 'X')
    # 从句和非谓语
    clauses = []
    for t in doc:
        ci = clause_info(t) if t.dep_ in ('relcl', 'acl', 'advcl', 'ccomp', 'csubj', 'csubjpass', 'pcomp', 'xcomp') else None
        if ci:
            st = subtree(t); ci['from'] = st[0].i; ci['to'] = st[-1].i
            clauses.append(ci)
    clauses = [c for c in clauses if not (c['type'] in ('不定式作宾语', '动名词 / 现在分词', '不定式') and len(c['text'].split()) < 2)]
    # 特殊句式
    special = []
    low = sentence.strip().lower()
    s_tok = next((c for c in root.children if c.dep_ in ('nsubj', 'nsubjpass')), None)
    is_q = sentence.strip().endswith('?') and not re.search(r'["”]\s*\w+[^?]*$', sentence.strip()[:-1])
    if any(c.dep_ == 'expl' and c.text.lower() == 'there' for c in root.children): special.append({'type': 'There be 句型', 'note': 'There + be + 某物 + 某处：表示“某处有某物”。真正的主语是 be 后面的名词，be 的单复数跟它走。'})
    if re.match(r'^(it)\s+(is|was)\b', low) and any(x.dep_ == 'relcl' and x.head.dep_ == 'attr' and any(y.text.lower() in ('that', 'who') for y in x.subtree) for x in doc):
        special.append({'type': '强调句（可能）', 'note': 'It is/was + 被强调的部分 + that/who + 其余部分。去掉 It is … that，句子仍然完整的话，就是强调句；强调的是中间那部分。'})
    if s_tok is not None and s_tok.i > root.i and not is_q and root.lemma_ in ('say', 'ask', 'reply', 'cry', 'shout', 'answer', 'whisper', 'continue', 'add', 'think', 'exclaim', 'murmur', 'call', 'scream', 'shriek'):
        special.append({'type': '引语后的倒装', 'note': '直接引语放在前面时，常写成 “……,” said Fern，把谓语 said 放到主语前面，意思不变。'})
    elif s_tok is not None and not is_q:
        aux_before = [c for c in root.children if c.dep_ == 'aux' and c.i < s_tok.i]
        if aux_before and re.match(r'^(not only|never|seldom|rarely|hardly|little|only|no sooner|nor|neither|so|such|under no|at no|in no)\b', low):
            special.append({'type': '倒装句', 'note': '否定词或 only 等放在句首时，后面用部分倒装：助动词提到主语前面（如 Not only did he …）。'})
    if re.match(r'^(what|how)\b', low) and sentence.strip().endswith('!'): special.append({'type': '感叹句', 'note': 'What + (a/an) + 形容词 + 名词 + 主语 + 谓语！ / How + 形容词或副词 + 主语 + 谓语！'})
    if any(t.text.lower() == 'not' and t.nbor(1).text.lower() == 'only' for t in doc if t.i + 1 < len(doc)) and any(t.text.lower() == 'but' for t in doc):
        special.append({'type': 'not only … but (also) …', 'note': '不但……而且……；连接两个并列成分。'})
    if root.lemma_ == 'wish' and re.search(r'\bwish(es|ed)?\s+(that\s+)?\w+\s+(could|would|were|had|might|knew|was)\b', low):
        special.append({'type': '虚拟语气（wish）', 'note': 'wish 后面的从句用过去式（be 多用 were）或 could/would + 原形，表示“要是……就好了”，是实现不了的愿望。'})
    if len(clauses_main) > 1:
        cc = next((x for x in doc if x.dep_ == 'cc' and x.head == root), None)
        special.append({'type': '并列句', 'note': '由 ' + (cc.text if cc is not None else '逗号/分号') + ' 连接的两个（或多个）完整分句，每个分句都有自己的主语和谓语。'})
    tname, passive = tense_of(root)
    def clause_summary(cm):
        p, r = cm['parts'], cm['root']
        tn, pv = tense_of(r)
        return {'pattern': pattern_of(p, r), 'S': core_text(p, 'S'), 'V': core_text(p, 'V'), 'O': core_text(p, 'O'), 'IO': core_text(p, 'IO'),
                'C': core_text(p, 'C'), 'OC': core_text(p, 'OC'),
                'core': ' '.join(x for x in [('There' if any(c.dep_ == 'expl' for c in r.children) else ''), short_head(p, 'S') if not any(c.dep_ == 'expl' for c in r.children) else '', core_text(p, 'V'), short_head(p, 'S') if any(c.dep_ == 'expl' for c in r.children) else '', short_head(p, 'IO'), short_head(p, 'O'), short_head(p, 'C'), short_head(p, 'OC')] if x),
                'tense': tn or '', 'passive': bool(pv)}
    imper = not s_tok and root.tag_ == 'VB' and not any(c.dep_ in ('expl', 'aux') for c in root.children) and root.i <= 2
    mood = '疑问句' if is_q else ('祈使句' if imper else ('感叹句' if sentence.strip().endswith('!') else '陈述句'))
    struct = '复合句（主句 + 从句）' if any(c['type'].endswith('从句') or '从句' in c['type'] for c in clauses) else '简单句'
    if len(clauses_main) > 1: struct = '并列复合句' if struct.startswith('复合') else '并列句'
    toks = [{'t': t.text, 'w': t.whitespace_ != '', 'r': roles.get(t.i, 'X')} for t in doc]
    return {'v': 1, 'mood': mood, 'struct': struct, 'main': [clause_summary(c) for c in clauses_main], 'clauses': clauses, 'special': special, 'tokens': toks}

if __name__ == '__main__':
    import spacy, json, sys
    nlp = spacy.load('en_core_web_md')
    for s in sys.argv[1:]:
        print(json.dumps(analyze(nlp, s), ensure_ascii=False, indent=1))
