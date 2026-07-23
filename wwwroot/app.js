// SNN GUI Analysis Environment — with Multi-Select, Rubber-Band, Bulk Property Edit
document.addEventListener('DOMContentLoaded', () => {
    // =========================================================================
    // アプリケーション状態
    // =========================================================================
    const state = {
        activeTool: 'select',
        neurons: [],
        externalSources: [],
        synapses: [],
        gapJunctions: [],
        nets: [],

        // 単一選択（接続線などクリックのみ対応）
        selectedItem: null,

        // ── 複数選択 ────────────────────────────────────────────────────
        // Set of { type: 'neuron'|'source', item }
        multiSelected: new Set(),

        // ── ドラッグ ─────────────────────────────────────────────────────
        draggingNode: null,
        dragOffset: { x: 0, y: 0 },
        // 複数ドラッグ用: Map<item, {origX, origY}>
        multiDragOrigins: null,
        dragAnchorPt: null,         // ドラッグ開始SVG座標

        // ── ラバーバンド選択 ─────────────────────────────────────────────
        isRubberBanding: false,
        rubberStart: null,          // SVG座標 {x, y}
        rubberRect: null,           // SVG rect element

        wireStartPort: null,

        // ── ビューポート 変換（パン / ズーム）──────────────────────
        zoom: 1.0,                 // ズーム倍率 (0.1 – 5.0)
        panX: 0,                   // パン offset X [ピクセル]
        panY: 0,                   // パン offset Y [ピクセル]

        // 中ボタンパン用
        isPanning: false,
        panStartMouse: null,        // パン開始時のスクリーン座標
        panStartOffset: null,       // パン開始時の panX/panY

        simChart: null,
        simResult: null,
        undoStack: [],
        redoStack: []
    };

    // =========================================================================
    // DOM要素
    // =========================================================================
    const svg           = document.getElementById('editorSvg');
    const canvasRoot    = document.getElementById('canvasRoot');  // パン/ズーム対象
    const gNodes        = document.getElementById('gNodes');
    const gWires        = document.getElementById('gWires');
    const gTempWire     = document.getElementById('gTempWire');
    const inspector     = document.getElementById('propertyInspector');
    const canvasStatus  = document.getElementById('canvasStatus');
    const netCountStatus= document.getElementById('netCountStatus');
    const presetSelect  = document.getElementById('presetSelect');
    const btnUndo       = document.getElementById('btnUndo');
    const btnRedo       = document.getElementById('btnRedo');
    const zoomIndicator = document.getElementById('zoomIndicator');

    // ラバーバンド選択矩形を canvasRoot に追加（ノードと同じ座標系）
    const rubberEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rubberEl.setAttribute('class', 'rubber-band');
    rubberEl.style.display = 'none';
    canvasRoot.appendChild(rubberEl);

    // =========================================================================
    // パン / ズーム 変換管理
    // =========================================================================
    /** canvasRoot の transform を更新する内部関数 */
    function applyTransform() {
        if (isNaN(state.zoom) || !state.zoom) state.zoom = 1.0;
        if (isNaN(state.panX) || state.panX === undefined) state.panX = 0;
        if (isNaN(state.panY) || state.panY === undefined) state.panY = 0;

        canvasRoot.setAttribute('transform',
            `translate(${state.panX}, ${state.panY}) scale(${state.zoom})`);
        if (zoomIndicator) {
            zoomIndicator.textContent = `${Math.round(state.zoom * 100)}%`;
        }
    }

    /** ズーム — カーソルを中心にズームする */
    function zoomAt(screenX, screenY, factor) {
        if (isNaN(state.zoom) || !state.zoom) state.zoom = 1.0;
        if (isNaN(state.panX) || state.panX === undefined) state.panX = 0;
        if (isNaN(state.panY) || state.panY === undefined) state.panY = 0;

        const svgRect  = svg.getBoundingClientRect();
        const localX   = screenX - svgRect.left;   // SVG要素内のスクリーン座標
        const localY   = screenY - svgRect.top;

        const newZoom  = Math.max(0.1, Math.min(5.0, state.zoom * factor));
        const zoomRatio= newZoom / state.zoom;

        // カーソル位置を固定するために panX/panY を調整
        state.panX  = localX - zoomRatio * (localX - state.panX);
        state.panY  = localY - zoomRatio * (localY - state.panY);
        state.zoom  = newZoom;
        applyTransform();
    }

    // 初期状態を適用
    applyTransform();

    // ── ブラウザ標準のテキスト選択・ドラッグ処理を抑止 ─────────────
    svg.addEventListener('selectstart', e => e.preventDefault());
    svg.addEventListener('dragstart', e => e.preventDefault());

    // ── ホイールズーム ────────────────────────────────────────────────
    svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        zoomAt(e.clientX, e.clientY, factor);
    }, { passive: false });

    // ── ホイールクリック（中ボタン）パン 開始のみここで捕捉 ──────────────
    svg.addEventListener('mousedown', (e) => {
        if (e.button !== 1) return;   // 中ボタンのみ
        e.preventDefault();
        state.isPanning      = true;
        state.panStartMouse  = { x: e.clientX, y: e.clientY };
        state.panStartOffset = { x: state.panX, y: state.panY };
        svg.classList.add('panning');
    });

    // ── ズームボタン（サイドバー）の接続 ────────────────────────────
    const btnZoomIn    = document.getElementById('btnZoomIn');
    const btnZoomOut   = document.getElementById('btnZoomOut');
    const btnZoomReset = document.getElementById('btnZoomReset');
    if (btnZoomIn)    btnZoomIn.addEventListener('click',    () => { const c = svgCenter(); zoomAt(c.x, c.y, 1.25); });
    if (btnZoomOut)   btnZoomOut.addEventListener('click',   () => { const c = svgCenter(); zoomAt(c.x, c.y, 0.8); });
    if (btnZoomReset) btnZoomReset.addEventListener('click', () => { state.zoom=1.0; state.panX=0; state.panY=0; applyTransform(); });
    function svgCenter() {
        const r = svg.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2 };
    }

    // =========================================================================
    // Undo / Redo
    // =========================================================================
    function pushHistorySnapshot() {
        const snap = JSON.stringify({
            neurons: state.neurons, externalSources: state.externalSources,
            synapses: state.synapses, gapJunctions: state.gapJunctions, nets: state.nets
        });
        if (state.undoStack.length > 0 && state.undoStack[state.undoStack.length - 1] === snap) return;
        state.undoStack.push(snap);
        if (state.undoStack.length > 50) state.undoStack.shift();
        state.redoStack = [];
        updateHistoryButtons();
    }

    function applySnapshot(snap) {
        const data = JSON.parse(snap);
        state.neurons         = data.neurons         || [];
        state.externalSources = data.externalSources || [];
        state.synapses        = data.synapses        || [];
        state.gapJunctions    = data.gapJunctions    || [];
        state.nets            = data.nets            || [];
        clearSelection();
        updateNetNames();
        renderCanvas();
        updateHistoryButtons();
    }

    function undo() {
        if (!state.undoStack.length) return;
        const cur = JSON.stringify({ neurons: state.neurons, externalSources: state.externalSources,
            synapses: state.synapses, gapJunctions: state.gapJunctions, nets: state.nets });
        state.redoStack.push(cur);
        applySnapshot(state.undoStack.pop());
        canvasStatus.textContent = '操作を取り消しました (Undo)';
    }

    function redo() {
        if (!state.redoStack.length) return;
        const cur = JSON.stringify({ neurons: state.neurons, externalSources: state.externalSources,
            synapses: state.synapses, gapJunctions: state.gapJunctions, nets: state.nets });
        state.undoStack.push(cur);
        applySnapshot(state.redoStack.pop());
        canvasStatus.textContent = '操作をやり直しました (Redo)';
    }

    function updateHistoryButtons() {
        if (btnUndo) btnUndo.disabled = state.undoStack.length === 0;
        if (btnRedo) btnRedo.disabled = state.redoStack.length === 0;
    }

    if (btnUndo) btnUndo.addEventListener('click', undo);
    if (btnRedo) btnRedo.addEventListener('click', redo);

    window.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.shiftKey ? redo() : undo(); e.preventDefault();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
            redo(); e.preventDefault();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
            // Ctrl+A: 全選択
            selectAll(); e.preventDefault();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            deleteSelected(); e.preventDefault();
        } else if (e.key === 'Escape') {
            clearSelection(); renderCanvas(); renderInspector();
        }
    });

    // =========================================================================
    // 選択管理ヘルパー
    // =========================================================================
    /** ノードのみ複数選択対象（接続線はシングル選択） */
    function isNodeEntry(entry) {
        return entry && (entry.type === 'neuron' || entry.type === 'source');
    }

    function clearSelection() {
        state.selectedItem = null;
        state.multiSelected.clear();
    }

    function selectAll() {
        state.selectedItem = null;
        state.multiSelected.clear();
        state.neurons.forEach(n => state.multiSelected.add({ type: 'neuron', item: n }));
        state.externalSources.forEach(s => state.multiSelected.add({ type: 'source', item: s }));
        renderCanvas();
        renderInspector();
    }

    /** 選択中のノード（neuron / source）一覧を返す */
    function selectedNodes() {
        return [...state.multiSelected].filter(e => isNodeEntry(e));
    }

    /** あるアイテムが選択中かどうか */
    function isSelected(item) {
        if (state.selectedItem?.item === item) return true;
        for (const e of state.multiSelected) if (e.item === item) return true;
        return false;
    }

    /**
     * ノードをクリックしたときの選択ロジック
     * @param {MouseEvent} e
     * @param {'neuron'|'source'} type
     * @param {Object} item
     */
    function handleNodeClick(e, type, item) {
        if (e.ctrlKey || e.metaKey) {
            // Ctrl+クリック → トグル追加
            state.selectedItem = null;
            const existing = [...state.multiSelected].find(en => en.item === item);
            if (existing) {
                state.multiSelected.delete(existing);
            } else {
                state.multiSelected.add({ type, item });
            }
        } else {
            // 通常クリック → 単独選択（ただし既に複数選択中でそのアイテムが含まれていれば維持）
            const alreadyInMulti = [...state.multiSelected].some(en => en.item === item);
            if (state.multiSelected.size <= 1 || !alreadyInMulti) {
                clearSelection();
                state.multiSelected.add({ type, item });
            }
            // （複数選択済みアイテムのクリックはドラッグ開始のみ → 選択維持）
        }
        renderCanvas();
        renderInspector();
    }

    /** 接続線（synapse / gap / net）をクリックしたときの選択ロジック */
    function handleEdgeClick(e, type, item) {
        e.stopPropagation();
        clearSelection();
        state.selectedItem = { type, item };
        renderCanvas();
        renderInspector();
    }

    // =========================================================================
    // ID生成
    // =========================================================================
    function generateNeuronId() { let i=1; while(state.neurons.some(n=>n.Id===`N${i}`))i++; return `N${i}`; }
    function generateSourceId() { let i=1; while(state.externalSources.some(s=>s.Id===`SRC${i}`))i++; return `SRC${i}`; }
    function generateSynapseId(){ let i=1; while(state.synapses.some(s=>s.Id===`SYN${i}`))i++; return `SYN${i}`; }
    function generateGapId()    { let i=1; while(state.gapJunctions.some(g=>g.Id===`GJ${i}`))i++; return `GJ${i}`; }

    // =========================================================================
    // ネット名自動更新
    // =========================================================================
    function updateNetNames() {
        const adj = new Map();
        function addEdge(u,v) {
            if(!adj.has(u)) adj.set(u,[]); if(!adj.has(v)) adj.set(v,[]);
            adj.get(u).push(v); adj.get(v).push(u);
        }
        state.neurons.forEach(n => adj.set(n.Id,[]));
        state.externalSources.forEach(s => adj.set(s.Id,[]));
        state.synapses.forEach(s => { if(s.PreNodeId&&s.PostNodeId) addEdge(s.PreNodeId,s.PostNodeId); });
        state.gapJunctions.forEach(g => { if(g.Node1Id&&g.Node2Id) addEdge(g.Node1Id,g.Node2Id); });
        state.nets.forEach(n => { if(n.FromNodeId&&n.ToNodeId) addEdge(n.FromNodeId,n.ToNodeId); });

        const visited = new Set(), components = [];
        for (let [id] of adj) {
            if (!visited.has(id)) {
                const comp=[], q=[id]; visited.add(id);
                while(q.length){ const c=q.shift(); comp.push(c);
                    for(let nb of (adj.get(c)||[])) if(!visited.has(nb)){visited.add(nb);q.push(nb);} }
                if(comp.length>1) components.push(comp);
            }
        }
        let ni=1;
        components.forEach(comp=>{
            const nm=`net${ni++}`;
            state.neurons.forEach(n=>{ if(comp.includes(n.Id)){
                const out=state.nets.find(w=>w.FromNodeId===n.Id);
                const inn=state.nets.find(w=>w.ToNodeId===n.Id);
                if(out) n.NodeOut=out.NetName||nm; else n.NodeOut=nm;
                if(inn) n.NodeIn =inn.NetName||nm; else n.NodeIn =nm;
            }});
            state.externalSources.forEach(s=>{ if(comp.includes(s.Id)&&!s.NodeOut) s.NodeOut=nm; });
        });
        netCountStatus.textContent=`ネット数: ${state.nets.length} | ノード数: ${state.neurons.length+state.externalSources.length}`;
    }

    // =========================================================================
    // キャンバス描画
    // =========================================================================
    function renderCanvas() {
        gNodes.innerHTML = '';
        gWires.innerHTML = '';

        // ── ネット配線 ───────────────────────────────────────────────────
        state.nets.forEach(wire => {
            const p1 = getPortPos(wire.FromNodeId,'out');
            const p2 = getPortPos(wire.ToNodeId,'in');
            if (!p1||!p2) return;
            const dx = Math.abs(p2.x-p1.x)/2;
            const path = makeSvg('path');
            path.setAttribute('d',`M ${p1.x} ${p1.y} C ${p1.x+dx} ${p1.y}, ${p2.x-dx} ${p2.y}, ${p2.x} ${p2.y}`);
            path.setAttribute('class','wire-path'+(state.selectedItem?.item===wire?' selected':''));
            path.addEventListener('click', e => handleEdgeClick(e,'net',wire));
            gWires.appendChild(path);

            const label = makeSvg('text');
            label.setAttribute('x',(p1.x+p2.x)/2); label.setAttribute('y',(p1.y+p2.y)/2-8);
            label.setAttribute('class','wire-label'); label.textContent=wire.NetName;
            gWires.appendChild(label);
        });

        // ── シナプス ─────────────────────────────────────────────────────
        state.synapses.forEach(syn => {
            const p1=getPortPos(syn.PreNodeId,'out'), p2=getPortPos(syn.PostNodeId,'in');
            if(!p1||!p2) return;
            const dx=Math.abs(p2.x-p1.x)/2;
            const line=makeSvg('path');
            line.setAttribute('d',`M ${p1.x} ${p1.y} C ${p1.x+dx} ${p1.y}, ${p2.x-dx} ${p2.y}, ${p2.x} ${p2.y}`);
            line.setAttribute('stroke','#a855f7'); line.setAttribute('stroke-width','2.5');
            line.setAttribute('fill','none'); line.setAttribute('stroke-dasharray','5,3');
            if (isSelected(syn)) { line.setAttribute('stroke','#f0abfc'); line.setAttribute('stroke-width','4'); }
            line.addEventListener('click', e => handleEdgeClick(e,'synapse',syn));
            gWires.appendChild(line);
        });

        // ── ギャップジャンクション ───────────────────────────────────────
        state.gapJunctions.forEach(gj => {
            const p1=getPortPos(gj.Node1Id,'out')||getPortPos(gj.Node1Id,'in');
            const p2=getPortPos(gj.Node2Id,'in')||getPortPos(gj.Node2Id,'out');
            if(!p1||!p2) return;
            const line=makeSvg('line');
            ['x1','y1','x2','y2'].forEach((a,i)=>line.setAttribute(a,[p1.x,p1.y,p2.x,p2.y][i]));
            line.setAttribute('stroke', isSelected(gj)?'#fde68a':'#f59e0b');
            line.setAttribute('stroke-width', isSelected(gj)?'4':'3');
            line.addEventListener('click', e => handleEdgeClick(e,'gap',gj));
            gWires.appendChild(line);
        });

        // ── ニューロン ───────────────────────────────────────────────────
        state.neurons.forEach(n => {
            const sel = isSelected(n);
            const g = makeSvg('g');
            g.setAttribute('class','node-group'+(sel?' selected':''));
            g.setAttribute('transform',`translate(${n.X},${n.Y})`);
            g.dataset.nodeId = n.Id;

            const rect = makeSvg('rect');
            rect.setAttribute('width','80'); rect.setAttribute('height','50');
            rect.setAttribute('class','node-rect-neuron');
            g.appendChild(rect);

            const text = makeSvg('text');
            text.setAttribute('x','40'); text.setAttribute('y','28');
            text.setAttribute('fill','#f8fafc'); text.setAttribute('font-size','14');
            text.setAttribute('font-weight','600'); text.setAttribute('text-anchor','middle');
            text.textContent = n.Id;
            g.appendChild(text);

            // 選択数バッジ（複数選択時に薄くバッジ表示）
            if (state.multiSelected.size > 1 && sel) {
                const badge = makeSvg('rect');
                badge.setAttribute('x','62'); badge.setAttribute('y','-8');
                badge.setAttribute('width','18'); badge.setAttribute('height','12');
                badge.setAttribute('rx','3'); badge.setAttribute('fill','#3b82f6');
                g.appendChild(badge);
                const badgeT = makeSvg('text');
                badgeT.setAttribute('x','71'); badgeT.setAttribute('y','1');
                badgeT.setAttribute('fill','#fff'); badgeT.setAttribute('font-size','9');
                badgeT.setAttribute('text-anchor','middle');
                badgeT.textContent = '✓';
                g.appendChild(badgeT);
            }

            // ポート
            const inPort = makeSvg('circle');
            inPort.setAttribute('cx','0'); inPort.setAttribute('cy','25'); inPort.setAttribute('r','5');
            inPort.setAttribute('class','port-circle');
            inPort.addEventListener('mousedown', e => startWireDrag(e,n.Id,'in',n.X,n.Y+25));
            g.appendChild(inPort);

            const outPort = makeSvg('circle');
            outPort.setAttribute('cx','80'); outPort.setAttribute('cy','25'); outPort.setAttribute('r','5');
            outPort.setAttribute('class','port-circle');
            outPort.addEventListener('mousedown', e => startWireDrag(e,n.Id,'out',n.X+80,n.Y+25));
            g.appendChild(outPort);

            g.addEventListener('mousedown', e => {
                if (e.target.classList.contains('port-circle')) return;
                e.stopPropagation();
                if (state.activeTool !== 'select') return;
                handleNodeClick(e,'neuron',n);
                startNodeDrag(e, n);
            });

            gNodes.appendChild(g);
        });

        // ── 外部電流源 ───────────────────────────────────────────────────
        state.externalSources.forEach(s => {
            const sel = isSelected(s);
            const g = makeSvg('g');
            g.setAttribute('class','node-group'+(sel?' selected':''));
            g.setAttribute('transform',`translate(${s.X},${s.Y})`);

            const circle = makeSvg('circle');
            circle.setAttribute('cx','25'); circle.setAttribute('cy','25'); circle.setAttribute('r','25');
            circle.setAttribute('class','node-circle-source');
            g.appendChild(circle);

            const text = makeSvg('text');
            text.setAttribute('x','25'); text.setAttribute('y','30');
            text.setAttribute('fill','#f59e0b'); text.setAttribute('font-size','12');
            text.setAttribute('font-weight','bold'); text.setAttribute('text-anchor','middle');
            text.textContent = s.Id;
            g.appendChild(text);

            const outPort = makeSvg('circle');
            outPort.setAttribute('cx','50'); outPort.setAttribute('cy','25'); outPort.setAttribute('r','5');
            outPort.setAttribute('class','port-circle');
            outPort.addEventListener('mousedown', e => startWireDrag(e,s.Id,'out',s.X+50,s.Y+25));
            g.appendChild(outPort);

            g.addEventListener('mousedown', e => {
                if (e.target.classList.contains('port-circle')) return;
                e.stopPropagation();
                if (state.activeTool !== 'select') return;
                handleNodeClick(e,'source',s);
                startNodeDrag(e, s);
            });

            gNodes.appendChild(g);
        });
    }

    function makeSvg(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }

    function getPortPos(nodeId, portType) {
        const n = state.neurons.find(n => n.Id === nodeId);
        if (n) return { x: portType==='in' ? n.X : n.X+80, y: n.Y+25 };
        const s = state.externalSources.find(s => s.Id === nodeId);
        if (s) return { x: s.X+50, y: s.Y+25 };
        return null;
    }

    // =========================================================================
    // ドラッグ（単一 or 複数）
    // =========================================================================
    function startNodeDrag(e, node) {
        e.preventDefault();
        e.stopPropagation();
        if (state.activeTool !== 'select') return;
        pushHistorySnapshot();
        const pt = getSvgCoords(e);
        state.dragAnchorPt = pt;

        // 複数選択中なら全対象の元座標を記録
        const nodes = selectedNodes();
        if (nodes.length > 1) {
            state.multiDragOrigins = new Map(nodes.map(en => [en.item, { origX: en.item.X, origY: en.item.Y }]));
            state.draggingNode = null;
        } else {
            state.draggingNode = node;
            state.dragOffset = { x: pt.x - node.X, y: pt.y - node.Y };
            state.multiDragOrigins = null;
        }
    }

    function startWireDrag(e, nodeId, portType, px, py) {
        e.preventDefault();
        e.stopPropagation();
        if (state.activeTool === 'select') return;
        state.wireStartPort = { nodeId, portType, x: px, y: py };
    }

    // =========================================================================
    // ラバーバンド選択（空白をドラッグ）
    // =========================================================================
    svg.addEventListener('mousedown', e => {
        if (e.button !== 0) return;                      // 左ボタンのみ
        if (state.activeTool !== 'select') return;
        // 背景（SVG自体 / canvasRoot / gridBg / gWires / ラベル）のときだけラバーバンド開始
        const t = e.target;
        const isBg = t === svg || t === canvasRoot || t.id === 'gridBg'
                  || t === gWires || t === gTempWire
                  || t.classList.contains('wire-label');
        if (!isBg) return;

        const pt = getSvgCoords(e);
        state.isRubberBanding = true;
        state.rubberStart = pt;

        rubberEl.setAttribute('x', pt.x); rubberEl.setAttribute('y', pt.y);
        rubberEl.setAttribute('width', 0); rubberEl.setAttribute('height', 0);
        rubberEl.style.display = 'block';

        // Ctrl なしで空白クリックは選択解除
        if (!e.ctrlKey && !e.metaKey) clearSelection();
    });


    // mousemove：パン・ノードドラッグ・ラバーバンド・ワイヤーを一本のハンドラで処理
    window.addEventListener('mousemove', e => {
        // ── パン（中ボタンドラッグ）──────────────────────────────────────
        if (state.isPanning && state.panStartMouse) {
            state.panX = state.panStartOffset.x + (e.clientX - state.panStartMouse.x);
            state.panY = state.panStartOffset.y + (e.clientY - state.panStartMouse.y);
            applyTransform();
            return; // パン中は他の処理をスキップ
        }

        const pt = getSvgCoords(e);

        // ── 複数ノードドラッグ ──────────────────────────────────────────
        if (state.multiDragOrigins) {
            const dx = pt.x - state.dragAnchorPt.x;
            const dy = pt.y - state.dragAnchorPt.y;
            for (const [item, orig] of state.multiDragOrigins) {
                const newX = orig.origX + dx;
                const newY = orig.origY + dy;
                if (!isNaN(newX)) item.X = newX;
                if (!isNaN(newY)) item.Y = newY;
            }
            renderCanvas();
            return;
        }

        // ── 単一ノードドラッグ ──────────────────────────────────────────
        if (state.draggingNode) {
            const newX = pt.x - state.dragOffset.x;
            const newY = pt.y - state.dragOffset.y;
            if (!isNaN(newX)) state.draggingNode.X = newX;
            if (!isNaN(newY)) state.draggingNode.Y = newY;
            renderCanvas();
        }

        // ── ワイヤー仮線 (スナップ機能付き) ─────────────────────────
        if (state.wireStartPort) {
            gTempWire.innerHTML = '';
            let targetX = pt.x;
            let targetY = pt.y;
            let isSnapped = false;

            const hoverNode = findNodeAt(pt.x, pt.y, 25);
            if (hoverNode && hoverNode.Id !== state.wireStartPort.nodeId) {
                const targetPort = getPortPos(hoverNode.Id, 'in') || getPortPos(hoverNode.Id, 'out');
                if (targetPort) {
                    targetX = targetPort.x;
                    targetY = targetPort.y;
                    isSnapped = true;
                }
            }

            const line = makeSvg('line');
            line.setAttribute('x1', state.wireStartPort.x); line.setAttribute('y1', state.wireStartPort.y);
            line.setAttribute('x2', targetX); line.setAttribute('y2', targetY);
            line.setAttribute('stroke', isSnapped ? '#4ade80' : '#38bdf8');
            line.setAttribute('stroke-width', isSnapped ? '3' : '2');
            line.setAttribute('stroke-dasharray', isSnapped ? 'none' : '4,4');
            gTempWire.appendChild(line);
        }

        // ── ラバーバンド ────────────────────────────────────────────────
        if (state.isRubberBanding && state.rubberStart) {
            const x = Math.min(pt.x, state.rubberStart.x);
            const y = Math.min(pt.y, state.rubberStart.y);
            const w = Math.abs(pt.x - state.rubberStart.x);
            const h = Math.abs(pt.y - state.rubberStart.y);
            rubberEl.setAttribute('x', x); rubberEl.setAttribute('y', y);
            rubberEl.setAttribute('width', w); rubberEl.setAttribute('height', h);

            const rx1=x, ry1=y, rx2=x+w, ry2=y+h;
            const newSel = new Set();
            state.neurons.forEach(n => {
                if (rectsOverlap(n.X, n.Y, 80, 50, rx1, ry1, rx2-rx1, ry2-ry1))
                    newSel.add({ type:'neuron', item:n });
            });
            state.externalSources.forEach(s => {
                if (rectsOverlap(s.X, s.Y, 50, 50, rx1, ry1, rx2-rx1, ry2-ry1))
                    newSel.add({ type:'source', item:s });
            });
            state.multiSelected = newSel;
            renderCanvas();
        }
    });

    // mouseup：パン終了・ドラッグ完了・ラバーバンド確定・ワイヤー接続を一本で処理
    window.addEventListener('mouseup', e => {
        // ── パン終了（中ボタン）──────────────────────────────────────────
        if (e.button === 1 && state.isPanning) {
            state.isPanning = false;
            state.panStartMouse = null;
            svg.classList.remove('panning');
            return;
        }

        // ── ラバーバンド確定 ────────────────────────────────────────────
        if (state.isRubberBanding) {
            state.isRubberBanding = false;
            rubberEl.style.display = 'none';
            state.rubberStart = null;
            renderInspector();
        }

        // ── ドラッグ完了 ────────────────────────────────────────────────
        if (state.draggingNode || state.multiDragOrigins) {
            state.draggingNode = null;
            state.multiDragOrigins = null;
            state.dragAnchorPt = null;
            updateNetNames();
        }

        // ── ワイヤー接続 ────────────────────────────────────────────────
        if (state.wireStartPort) {
            gTempWire.innerHTML = '';
            const pt = getSvgCoords(e);
            const targetNode = findNodeAt(pt.x, pt.y, 25);
            if (targetNode && targetNode.Id !== state.wireStartPort.nodeId) {
                pushHistorySnapshot();
                if (state.activeTool === 'synapse') {
                    const syn = { Id: generateSynapseId(), PreNodeId: state.wireStartPort.nodeId,
                        PostNodeId: targetNode.Id, NetName: `net_syn${state.synapses.length+1}`,
                        Gm_S: 10e-6, Weight: 1.9, Vref_V: 0.9, Threshold_V: 0.9,
                        Tdelay_s: 20e-6, IsExponential: false, TauR_s: 1e-6, TauD_s: 1e-6,
                        EnableStdp: false, StdpLr: 0.01 };
                    state.synapses.push(syn);
                    handleEdgeClick(e,'synapse',syn);
                } else if (state.activeTool === 'gap') {
                    const gj = { Id: generateGapId(), Node1Id: state.wireStartPort.nodeId,
                        Node2Id: targetNode.Id, NetName: `net_gj${state.gapJunctions.length+1}`,
                        Resistance_ohm: 1e6 };
                    state.gapJunctions.push(gj);
                    handleEdgeClick(e,'gap',gj);
                } else {
                    const net = { NetName: `net${state.nets.length+1}`,
                        FromNodeId: state.wireStartPort.nodeId, ToNodeId: targetNode.Id };
                    state.nets.push(net);
                    handleEdgeClick(e,'net',net);
                }
                updateNetNames(); renderCanvas();
            }
            state.wireStartPort = null;
        }
    });

    function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
        return ax < bx+bw && ax+aw > bx && ay < by+bh && ay+ah > by;
    }

    function getSvgCoords(e) {
        const rect = svg.getBoundingClientRect();
        const panX = (isNaN(state.panX) || state.panX === undefined) ? 0 : state.panX;
        const panY = (isNaN(state.panY) || state.panY === undefined) ? 0 : state.panY;
        const zoom = (isNaN(state.zoom) || !state.zoom) ? 1.0 : state.zoom;

        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        return {
            x: (screenX - panX) / zoom,
            y: (screenY - panY) / zoom
        };
    }

    function findNodeAt(x, y, padding = 20) {
        // 1. 端子 (Port) 付近の判定（半径 25px 以内なら最優先で吸着接続）
        for (let n of state.neurons) {
            if (Math.hypot(x - n.X, y - (n.Y + 25)) <= 25) return n;        // inPort
            if (Math.hypot(x - (n.X + 80), y - (n.Y + 25)) <= 25) return n; // outPort
        }
        for (let s of state.externalSources) {
            if (Math.hypot(x - (s.X + 50), y - (s.Y + 25)) <= 25) return s; // outPort
        }

        // 2. ノードの本体＋パディング（余白マージン）判定
        for (let n of state.neurons)
            if (x >= n.X - padding && x <= n.X + 80 + padding && y >= n.Y - padding && y <= n.Y + 50 + padding) return n;
        for (let s of state.externalSources)
            if (Math.hypot(x - (s.X + 25), y - (s.Y + 25)) <= 25 + padding) return s;

        return null;
    }

    // キャンバスクリックでノード配置（背景クリック時のみ）
    svg.addEventListener('click', e => {
        if (state.activeTool === 'select') return;
        // gridBg, canvasRoot, svg 自身のどれかが対象のときだけ配置
        const t = e.target;
        const isBg = t === svg || t === canvasRoot || t.id === 'gridBg';
        if (!isBg) return;
        const pt = getSvgCoords(e);
        pushHistorySnapshot();
        if (state.activeTool === 'neuron') {
            const n = { Id:generateNeuronId(), X:Math.round(pt.x-40), Y:Math.round(pt.y-25),
                NodeIn:'', NodeOut:'', C_F:400e-15, R_ohm:50e6, Vth_V:0.30, Vreset_V:0.00,
                VDD_V:1.80, Refractory_s:2e-3, Tr_s:5e-6, Tf_s:5e-6, Tk_s:10e-6,
                IsSelf:false, SelfPeriod_s:50e-6 };
            state.neurons.push(n);
            clearSelection();
            state.multiSelected.add({ type:'neuron', item:n });
        } else if (state.activeTool === 'source') {
            const s = { Id:generateSourceId(), X:Math.round(pt.x-25), Y:Math.round(pt.y-25),
                NodeOut:'', I0_A:50e-6, DeltaI_A:0.0, SineAmplitude_A:0.0,
                SineFreq_Hz:20e3, StartTime_s:5e-6, Duration_s:50e-6 };
            state.externalSources.push(s);
            clearSelection();
            state.multiSelected.add({ type:'source', item:s });
        }
        updateNetNames(); renderCanvas(); renderInspector();
    });

    // =========================================================================
    // プロパティインスペクタ描画
    // =========================================================================
    function renderInspector() {
        const nodes = selectedNodes();
        const multiCount = nodes.length;

        // ── 複数選択時 ────────────────────────────────────────────────────
        if (multiCount > 1) {
            const types = [...new Set(nodes.map(n => n.type))];
            const allNeurons  = types.every(t => t === 'neuron');
            const allSources  = types.every(t => t === 'source');
            const hasMixed    = !allNeurons && !allSources;

            if (hasMixed) {
                inspector.innerHTML = `
                    <div class="prop-card multi-select-card">
                        <div class="multi-badge">${multiCount} 個選択中</div>
                        <p class="empty-selection">ニューロンと電流源が混在しています。<br>同じ種類のノードのみ一括編集できます。</p>
                    </div>`;
                return;
            }

            if (allNeurons) renderMultiNeuronInspector(nodes.map(n=>n.item));
            else if (allSources) renderMultiSourceInspector(nodes.map(n=>n.item));
            return;
        }

        // ── 単一選択（マルチセットの1件 or selectedItem）─────────────────
        if (multiCount === 1) {
            const { type, item } = nodes[0];
            renderSingleInspector(type, item);
            return;
        }

        if (state.selectedItem) {
            renderSingleInspector(state.selectedItem.type, state.selectedItem.item);
            return;
        }

        inspector.innerHTML = '<p class="empty-selection">ノードまたは接続線を選択すると<br>パラメータ編集パネルが表示されます。<br><br>💡 Ctrl+クリック / ドラッグ で複数選択</p>';
    }

    // ── 複数ニューロン一括編集 ──────────────────────────────────────────────
    function renderMultiNeuronInspector(items) {
        // 共通値があるフィールドのデフォルト値を表示、異なる場合は空欄
        const common = (key) => {
            const vals = items.map(i => i[key]);
            return vals.every(v => v === vals[0]) ? vals[0] : '';
        };

        inspector.innerHTML = `
            <div class="prop-card multi-select-card">
                <div class="multi-badge">${items.length} ニューロン 一括編集</div>
                <p class="multi-hint">空欄のフィールドは各ノードで値が異なります。<br>入力すると全ノードに適用されます。</p>
                <div class="prop-field">
                    <label>静電容量 C (F):</label>
                    <input type="number" id="mC" value="${common('C_F')}" step="1e-15" placeholder="（混在）">
                </div>
                <div class="prop-field">
                    <label>抵抗 R (Ω):</label>
                    <input type="number" id="mR" value="${common('R_ohm')}" step="1e6" placeholder="（混在）">
                </div>
                <div class="prop-field">
                    <label>閾値電圧 V_th (V):</label>
                    <input type="number" id="mVth" value="${common('Vth_V')}" step="0.05" placeholder="（混在）">
                </div>
                <div class="prop-field">
                    <label>リセット電圧 V_reset (V):</label>
                    <input type="number" id="mVreset" value="${common('Vreset_V')}" step="0.05" placeholder="（混在）">
                </div>
                <div class="prop-field">
                    <label>電源電圧 VDD (V):</label>
                    <input type="number" id="mVdd" value="${common('VDD_V')}" step="0.1" placeholder="（混在）">
                </div>
                <div class="prop-field">
                    <label>不応期 T_ref (s):</label>
                    <input type="number" id="mRef" value="${common('Refractory_s')}" step="1e-4" placeholder="（混在）">
                </div>
                <div class="prop-field">
                    <label>立上り時間 T_r (s):</label>
                    <input type="number" id="mTr" value="${common('Tr_s')}" step="1e-6" placeholder="（混在）">
                </div>
                <div class="prop-field">
                    <label>パルス継続 T_k (s):</label>
                    <input type="number" id="mTk" value="${common('Tk_s')}" step="1e-6" placeholder="（混在）">
                </div>
                <div class="prop-field">
                    <label>立下り時間 T_f (s):</label>
                    <input type="number" id="mTf" value="${common('Tf_s')}" step="1e-6" placeholder="（混在）">
                </div>
                <div class="prop-field">
                    <label><input type="checkbox" id="mIsSelf" ${common('IsSelf')===true?'checked':''}> 自励振モード</label>
                </div>
                <div class="prop-field">
                    <label>自励振周期 (s):</label>
                    <input type="number" id="mSelfPeriod" value="${common('SelfPeriod_s')}" step="1e-6" placeholder="（混在）">
                </div>
                <div class="multi-apply-hint">↑ 値を変更すると選択中の全ノードに即反映</div>
            </div>`;

        function bindMulti(id, key, parse) {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', (e) => {
                const raw = e.target.value;
                if (raw === '' || raw === null) return;
                const val = parse(raw);
                if (isNaN(val) && typeof val !== 'boolean') return;
                pushHistorySnapshot();
                items.forEach(item => { item[key] = val; });
            });
        }
        bindMulti('mC',         'C_F',         parseFloat);
        bindMulti('mR',         'R_ohm',       parseFloat);
        bindMulti('mVth',       'Vth_V',       parseFloat);
        bindMulti('mVreset',    'Vreset_V',    parseFloat);
        bindMulti('mVdd',       'VDD_V',       parseFloat);
        bindMulti('mRef',       'Refractory_s',parseFloat);
        bindMulti('mTr',        'Tr_s',        parseFloat);
        bindMulti('mTk',        'Tk_s',        parseFloat);
        bindMulti('mTf',        'Tf_s',        parseFloat);
        bindMulti('mSelfPeriod','SelfPeriod_s',parseFloat);
        document.getElementById('mIsSelf').addEventListener('change', e => {
            pushHistorySnapshot();
            items.forEach(item => { item.IsSelf = e.target.checked; });
        });
    }

    // ── 複数電流源一括編集 ─────────────────────────────────────────────────
    function renderMultiSourceInspector(items) {
        const common = (key) => {
            const vals = items.map(i => i[key]);
            return vals.every(v => v === vals[0]) ? vals[0] : '';
        };
        inspector.innerHTML = `
            <div class="prop-card multi-select-card">
                <div class="multi-badge">${items.length} 電流源 一括編集</div>
                <div class="prop-field">
                    <label>初期電流 I0 (A):</label>
                    <input type="number" id="mI0" value="${common('I0_A')}" step="1e-6" placeholder="（混在）">
                </div>
                <div class="prop-field">
                    <label>増分電流 ΔI (A/step):</label>
                    <input type="number" id="mDeltaI" value="${common('DeltaI_A')}" step="1e-7" placeholder="（混在）">
                </div>
                <div class="prop-field">
                    <label>開始時間 (s):</label>
                    <input type="number" id="mStart" value="${common('StartTime_s')}" step="1e-6" placeholder="（混在）">
                </div>
                <div class="prop-field">
                    <label>継続時間 (s):</label>
                    <input type="number" id="mDuration" value="${common('Duration_s')}" step="1e-6" placeholder="（混在）">
                </div>
                <div class="multi-apply-hint">↑ 値を変更すると選択中の全電流源に即反映</div>
            </div>`;
        function bindMultiSrc(id, key) {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', e => {
                if (e.target.value === '') return;
                pushHistorySnapshot();
                items.forEach(item => { item[key] = parseFloat(e.target.value); });
            });
        }
        bindMultiSrc('mI0',      'I0_A');
        bindMultiSrc('mDeltaI',  'DeltaI_A');
        bindMultiSrc('mStart',   'StartTime_s');
        bindMultiSrc('mDuration','Duration_s');
    }

    // ── 単一アイテム編集 ────────────────────────────────────────────────────
    function renderSingleInspector(type, item) {
        if (type === 'neuron') {
            inspector.innerHTML = `
                <div class="prop-card">
                    <h4>ニューロンモデル (${item.Id})</h4>
                    <div class="prop-field"><label>ノードID:</label><input type="text" id="propId" value="${item.Id}"></div>
                    <div class="prop-field"><label>静電容量 C (F):</label><input type="number" id="propC" value="${item.C_F}" step="1e-15"></div>
                    <div class="prop-field"><label>抵抗 R (Ω):</label><input type="number" id="propR" value="${item.R_ohm}" step="1e6"></div>
                    <div class="prop-field"><label>閾値電圧 V_th (V):</label><input type="number" id="propVth" value="${item.Vth_V}" step="0.05"></div>
                    <div class="prop-field"><label>リセット電圧 V_reset (V):</label><input type="number" id="propVreset" value="${item.Vreset_V}" step="0.05"></div>
                    <div class="prop-field"><label>電源電圧 VDD (V):</label><input type="number" id="propVdd" value="${item.VDD_V}" step="0.1"></div>
                    <div class="prop-field"><label>不応期 T_ref (s):</label><input type="number" id="propRef" value="${item.Refractory_s}" step="1e-4"></div>
                    <div class="prop-field"><label>立上り時間 T_r (s):</label><input type="number" id="propTr" value="${item.Tr_s}" step="1e-6"></div>
                    <div class="prop-field"><label>パルス継続 T_k (s):</label><input type="number" id="propTk" value="${item.Tk_s}" step="1e-6"></div>
                    <div class="prop-field"><label>立下り時間 T_f (s):</label><input type="number" id="propTf" value="${item.Tf_s}" step="1e-6"></div>
                    <div class="prop-field"><label><input type="checkbox" id="propIsSelf" ${item.IsSelf?'checked':''}> 自励振モード</label></div>
                    <div class="prop-field"><label>自励振周期 T (s):</label><input type="number" id="propSelfPeriod" value="${item.SelfPeriod_s}" step="1e-6"></div>
                </div>`;
            bind('propId',         v => { item.Id = v; renderCanvas(); },         v=>v,         true);
            bind('propC',          v => { item.C_F = v; },                        parseFloat);
            bind('propR',          v => { item.R_ohm = v; },                      parseFloat);
            bind('propVth',        v => { item.Vth_V = v; },                      parseFloat);
            bind('propVreset',     v => { item.Vreset_V = v; },                   parseFloat);
            bind('propVdd',        v => { item.VDD_V = v; },                      parseFloat);
            bind('propRef',        v => { item.Refractory_s = v; },               parseFloat);
            bind('propTr',         v => { item.Tr_s = v; },                       parseFloat);
            bind('propTk',         v => { item.Tk_s = v; },                       parseFloat);
            bind('propTf',         v => { item.Tf_s = v; },                       parseFloat);
            bind('propSelfPeriod', v => { item.SelfPeriod_s = v; },               parseFloat);
            document.getElementById('propIsSelf').addEventListener('change', e => { pushHistorySnapshot(); item.IsSelf = e.target.checked; });

        } else if (type === 'source') {
            inspector.innerHTML = `
                <div class="prop-card">
                    <h4>外部電流源 (${item.Id})</h4>
                    <div class="prop-field"><label>ノードID:</label><input type="text" id="propId" value="${item.Id}"></div>
                    <div class="prop-field"><label>初期電流 I0 (A):</label><input type="number" id="propI0" value="${item.I0_A}" step="1e-6"></div>
                    <div class="prop-field"><label>増分電流 ΔI (A/step):</label><input type="number" id="propDeltaI" value="${item.DeltaI_A}" step="1e-7"></div>
                    <div class="prop-field"><label>サイン波振幅 (A):</label><input type="number" id="propSineAmp" value="${item.SineAmplitude_A||0}" step="1e-7"></div>
                    <div class="prop-field"><label>サイン波周波数 (Hz):</label><input type="number" id="propSineFreq" value="${item.SineFreq_Hz||20000}" step="1000"></div>
                    <div class="prop-field"><label>開始時間 (s):</label><input type="number" id="propStart" value="${item.StartTime_s}" step="1e-6"></div>
                    <div class="prop-field"><label>継続時間 (s):</label><input type="number" id="propDuration" value="${item.Duration_s}" step="1e-6"></div>
                </div>`;
            bind('propId',       v => { item.Id = v; renderCanvas(); }, v=>v, true);
            bind('propI0',       v => { item.I0_A = v; },               parseFloat);
            bind('propDeltaI',   v => { item.DeltaI_A = v; },           parseFloat);
            bind('propSineAmp',  v => { item.SineAmplitude_A = v; },    parseFloat);
            bind('propSineFreq', v => { item.SineFreq_Hz = v; },        parseFloat);
            bind('propStart',    v => { item.StartTime_s = v; },        parseFloat);
            bind('propDuration', v => { item.Duration_s = v; },         parseFloat);

        } else if (type === 'synapse') {
            inspector.innerHTML = `
                <div class="prop-card">
                    <h4>シナプスモデル (${item.Id})</h4>
                    <div class="prop-field"><label>コンダクタンス Gm (S):</label><input type="number" id="propGm" value="${item.Gm_S}" step="1e-6"></div>
                    <div class="prop-field"><label>結合荷重 Vw (V):</label><input type="number" id="propWeight" value="${item.Weight}" step="0.1"></div>
                    <div class="prop-field"><label>基準電圧 Vref (V):</label><input type="number" id="propVref" value="${item.Vref_V}" step="0.1"></div>
                    <div class="prop-field"><label>閾値電圧 V_th (V):</label><input type="number" id="propSynVth" value="${item.Threshold_V}" step="0.05"></div>
                    <div class="prop-field"><label>軸索遅延 T_delay (s):</label><input type="number" id="propDelay" value="${item.Tdelay_s}" step="1e-6"></div>
                    <div class="prop-field"><label><input type="checkbox" id="propIsExp" ${item.IsExponential?'checked':''}> 指数電流モード</label></div>
                    <div class="prop-field"><label>立上り時定数 τ_R (s):</label><input type="number" id="propTauR" value="${item.TauR_s}" step="1e-7"></div>
                    <div class="prop-field"><label>立下り時定数 τ_D (s):</label><input type="number" id="propTauD" value="${item.TauD_s}" step="1e-7"></div>
                    <div class="prop-field"><label><input type="checkbox" id="propStdp" ${item.EnableStdp?'checked':''}> STDP学習</label></div>
                    <div class="prop-field"><label>STDP 学習率:</label><input type="number" id="propStdpLr" value="${item.StdpLr||0.01}" step="0.001"></div>
                </div>`;
            bind('propGm',     v => { item.Gm_S = v; },       parseFloat);
            bind('propWeight', v => { item.Weight = v; },      parseFloat);
            bind('propVref',   v => { item.Vref_V = v; },      parseFloat);
            bind('propSynVth', v => { item.Threshold_V = v; }, parseFloat);
            bind('propDelay',  v => { item.Tdelay_s = v; },    parseFloat);
            bind('propTauR',   v => { item.TauR_s = v; },      parseFloat);
            bind('propTauD',   v => { item.TauD_s = v; },      parseFloat);
            bind('propStdpLr', v => { item.StdpLr = v; },      parseFloat);
            document.getElementById('propIsExp').addEventListener('change', e => { pushHistorySnapshot(); item.IsExponential = e.target.checked; });
            document.getElementById('propStdp').addEventListener('change',  e => { pushHistorySnapshot(); item.EnableStdp = e.target.checked; });

        } else if (type === 'gap') {
            inspector.innerHTML = `
                <div class="prop-card">
                    <h4>ギャップジャンクション (${item.Id})</h4>
                    <div class="prop-field"><label>抵抗 R_gj (Ω):</label><input type="number" id="propGjR" value="${item.Resistance_ohm}" step="1e4"></div>
                </div>`;
            bind('propGjR', v => { item.Resistance_ohm = v; }, parseFloat);

        } else if (type === 'net') {
            inspector.innerHTML = `
                <div class="prop-card">
                    <h4>配線ネット (${item.NetName})</h4>
                    <div class="prop-field"><label>ネット名:</label><input type="text" id="propNetName" value="${item.NetName}"></div>
                </div>`;
            bind('propNetName', v => { item.NetName = v; updateNetNames(); renderCanvas(); }, v=>v, true);
        }
    }

    function bind(id, setter, parser = parseFloat, noConvert = false) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', e => {
            pushHistorySnapshot();
            setter(noConvert ? e.target.value : parser(e.target.value));
        });
    }

    // =========================================================================
    // 削除・クローン・クリア
    // =========================================================================
    function deleteSelected() {
        const nodes = selectedNodes();
        if (nodes.length > 0) {
            pushHistorySnapshot();
            nodes.forEach(({ type, item }) => {
                if (type === 'neuron') {
                    state.neurons = state.neurons.filter(n => n !== item);
                    state.nets = state.nets.filter(w => w.FromNodeId !== item.Id && w.ToNodeId !== item.Id);
                    state.synapses = state.synapses.filter(s => s.PreNodeId !== item.Id && s.PostNodeId !== item.Id);
                } else if (type === 'source') {
                    state.externalSources = state.externalSources.filter(s => s !== item);
                }
            });
        } else if (state.selectedItem) {
            pushHistorySnapshot();
            const { type, item } = state.selectedItem;
            if (type === 'net')     state.nets = state.nets.filter(w => w !== item);
            if (type === 'synapse') state.synapses = state.synapses.filter(s => s !== item);
            if (type === 'gap')     state.gapJunctions = state.gapJunctions.filter(g => g !== item);
        }
        clearSelection();
        updateNetNames(); renderCanvas(); renderInspector();
    }

    document.getElementById('btnDeleteSelected').addEventListener('click', deleteSelected);

    document.getElementById('btnCloneSelected').addEventListener('click', () => {
        const nodes = selectedNodes();
        if (!nodes.length) return;
        pushHistorySnapshot();
        const cloned = [];
        nodes.forEach(({ type, item }) => {
            if (type === 'neuron') {
                const c = { ...JSON.parse(JSON.stringify(item)),
                    Id: item.Id.includes('_copy') ? item.Id+'_1' : item.Id+'_copy',
                    X: item.X + 40, Y: item.Y + 40 };
                state.neurons.push(c);
                cloned.push({ type, item: c });
            } else if (type === 'source') {
                const c = { ...JSON.parse(JSON.stringify(item)), Id: item.Id+'_copy', X: item.X+30, Y: item.Y+30 };
                state.externalSources.push(c);
                cloned.push({ type, item: c });
            }
        });
        clearSelection();
        cloned.forEach(e => state.multiSelected.add(e));
        updateNetNames(); renderCanvas(); renderInspector();
    });

    document.getElementById('btnClearCanvas').addEventListener('click', () => {
        if (!confirm('キャンバスの全ノードおよび接続をクリアしますか？')) return;
        pushHistorySnapshot();
        state.neurons=[]; state.externalSources=[]; state.synapses=[];
        state.gapJunctions=[]; state.nets=[];
        clearSelection(); updateNetNames(); renderCanvas(); renderInspector();
    });

    // =========================================================================
    // ツールバー
    // =========================================================================
    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.activeTool = btn.dataset.tool;
            canvasStatus.textContent = `選択モード: ${btn.textContent.trim()}`;
        });
    });

    // =========================================================================
    // JSON 保存 / 読込
    // =========================================================================
    document.getElementById('btnSaveJson').addEventListener('click', () => {
        const topology = { Neurons: state.neurons, ExternalSources: state.externalSources,
            Synapses: state.synapses, GapJunctions: state.gapJunctions, Nets: state.nets };
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(topology, null, 2)], { type: 'application/json' }));
        a.download = `snn_network_${Date.now()}.json`;
        a.click();
    });

    document.getElementById('btnLoadJson').addEventListener('click', () => document.getElementById('fileInputJson').click());
    document.getElementById('fileInputJson').addEventListener('change', (e) => {
        const file = e.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try { pushHistorySnapshot(); loadTopology(JSON.parse(ev.target.result)); }
            catch(err) { alert('JSONの読み込みに失敗しました: ' + err.message); }
        };
        reader.readAsText(file);
    });

    function loadTopology(t) {
        state.neurons=t.Neurons||[]; state.externalSources=t.ExternalSources||[];
        state.synapses=t.Synapses||[]; state.gapJunctions=t.GapJunctions||[]; state.nets=t.Nets||[];
        clearSelection(); updateNetNames(); renderCanvas(); renderInspector();
    }

    // =========================================================================
    // プリセット
    // =========================================================================
    document.getElementById('btnLoadPreset').addEventListener('click', async () => {
        const name = presetSelect.value; if (!name) return;
        try {
            const resp = await fetch(`/api/network/preset/${name}`);
            if (!resp.ok) throw new Error('プリセット取得失敗');
            pushHistorySnapshot(); loadTopology(await resp.json());
        } catch(err) { alert(err.message); }
    });

    // =========================================================================
    // シミュレーション実行 & 波形描画
    // =========================================================================
    document.getElementById('btnRunSim').addEventListener('click', async () => {
        const tEnd = parseFloat(document.getElementById('simTEnd').value) * 1e-6;
        const dt   = parseFloat(document.getElementById('simDt').value)   * 1e-9;
        const body = {
            Topology: { Neurons: state.neurons, ExternalSources: state.externalSources,
                Synapses: state.synapses, GapJunctions: state.gapJunctions, Nets: state.nets },
            Config: { T_end_s: tEnd, dt_s: dt }
        };
        try {
            canvasStatus.textContent = 'シミュレーション実行中...';
            const resp = await fetch('/api/simulation/run', {
                method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
            });
            if (!resp.ok) throw new Error('シミュレーション実行エラー');
            const result = await resp.json();
            state.simResult = result;
            renderWaveformChart(result);
            canvasStatus.textContent = 'シミュレーション完了！波形を描画しました。';
        } catch(err) { alert('シミュレーションエラー: ' + err.message); canvasStatus.textContent='エラーが発生しました。'; }
    });

    function renderWaveformChart(result) {
        const ctx = document.getElementById('chartCanvas').getContext('2d');
        if (state.simChart) state.simChart.destroy();
        const timesUs = result.timeSteps.map(t => (t*1e6).toFixed(2));
        const colors  = ['#3b82f6','#14b8a6','#f59e0b','#ef4444','#a855f7','#ec4899'];
        const datasets = [];
        if (result.data.length > 0) {
            Object.keys(result.data[0].voltages).forEach((nodeId, i) => {
                datasets.push({
                    label: `${nodeId} 膜電位 (V)`,
                    data: result.data.map(d => d.voltages[nodeId]),
                    borderColor: colors[i % colors.length],
                    borderWidth: 2, pointRadius: 0, fill: false
                });
            });
        }
        state.simChart = new Chart(ctx, {
            type:'line', data:{ labels: timesUs, datasets },
            options:{ responsive:true, maintainAspectRatio:false, animation:false,
                scales:{
                    x:{ title:{display:true,text:'Time (µs)',color:'#94a3b8'}, ticks:{color:'#94a3b8'}, grid:{color:'rgba(255,255,255,0.05)'} },
                    y:{ title:{display:true,text:'Voltage (V)',color:'#94a3b8'}, ticks:{color:'#94a3b8'}, grid:{color:'rgba(255,255,255,0.05)'} }
                },
                plugins:{ legend:{ labels:{color:'#f8fafc'} } }
            }
        });
    }

    document.getElementById('btnToggleWaveform').addEventListener('click', () =>
        document.getElementById('waveformPanel').classList.toggle('collapsed'));

    // =========================================================================
    // 初期化
    // =========================================================================
    document.getElementById('presetSelect').value = 'fig1';
    document.getElementById('btnLoadPreset').click();
    updateHistoryButtons();
});
