namespace SnnEditor;

public class SnnSimulationEngine
{
    // -----------------------------------------------------------------------
    // 内部状態クラス
    // -----------------------------------------------------------------------

    private class NeuronState
    {
        public NeuronModel Model { get; set; } = new();
        public double MembraneVoltage { get; set; } = 0.0;
        public double CurrentThreshold { get; set; } = 0.3;

        // 発火パルス生成
        public bool IsFiring { get; set; } = false;
        public double FireTimeElapsed { get; set; } = 0.0;

        // 【修正 Bug2】不応期フラグ中は RC更新を完全停止
        public bool IsInRefractory { get; set; } = false;
        public double RefractoryTimeElapsed { get; set; } = 0.0;
        public double TauRef { get; set; } = 1.0;

        // 【修正 Bug3】充電フェーズ判定用
        public bool IsCharging { get; set; } = true;

        public double InjectedCurrentSum { get; set; } = 0.0;
        public int SpikeCount { get; set; } = 0;
        public double LastSpikeTime { get; set; } = double.NegativeInfinity;
    }

    private class SynapseState
    {
        public SynapseModel Model { get; set; } = new();
        public double CurrentSynapticCurrent { get; set; } = 0.0;
        public double RiseTimer { get; set; } = 0.0;
        public double DecayTimer { get; set; } = 0.0;

        // 【修正 Bug1】シフトレジスタ方式の軸索遅延バッファ (固定長配列)
        public double[] DelayBuffer { get; set; } = Array.Empty<double>();
        public int DelaySteps { get; set; } = 0;

        // STDP用 発火時刻保存
        public double LastPreSpikeTime { get; set; } = double.NegativeInfinity;
        public double LastPostSpikeTime { get; set; } = double.NegativeInfinity;
    }

    // -----------------------------------------------------------------------
    // シミュレーション本体
    // -----------------------------------------------------------------------

    public SimulationResult RunSimulation(SnnNetworkTopology topology, SimulationConfig config)
    {
        double dt   = config.dt_s > 0   ? config.dt_s   : 30e-9;
        double tEnd = config.T_end_s > 0 ? config.T_end_s : 100e-6;

        var result        = new SimulationResult();
        var neuronStates  = new Dictionary<string, NeuronState>();
        var synapseStates = new Dictionary<string, SynapseState>();

        // ── ニューロン初期化 ──────────────────────────────────────────
        foreach (var n in topology.Neurons)
        {
            double vth0 = n.Vth_V;
            double vdd  = n.VDD_V > 0 ? n.VDD_V : 1.8;
            double tRef = n.Refractory_s > 0 ? n.Refractory_s : 2e-3;

            // 不応期時定数: t_RRP 終了時に閾値が初期値に対して 1/100 まで下がる条件から逆算
            // V_none(T_ref) = (Vdd - Vth0) * exp(-T_ref / tau) ≈ 0  →  tau = -T_ref / ln(Vth0 / Vdd / 100)
            double logArg = (vdd > 0 && vth0 > 0) ? (1.0 / 100.0) * (vth0 / vdd) : 1e-4;
            if (logArg <= 0) logArg = 1e-10;
            double tauRef = -tRef / Math.Log(logArg);
            if (double.IsNaN(tauRef) || tauRef <= 0) tauRef = tRef / 4.6;

            neuronStates[n.Id] = new NeuronState
            {
                Model             = n,
                MembraneVoltage   = n.Vreset_V,
                CurrentThreshold  = n.Vth_V,
                TauRef            = tauRef,
                IsCharging        = true
            };
            result.SpikeCounts[n.Id] = 0;
        }

        // ── シナプス初期化 ──────────────────────────────────────────
        foreach (var syn in topology.Synapses)
        {
            // 【修正 Bug1】遅延ステップ数 n = Tdelay / dt の固定長配列を確保
            int delaySteps = syn.Tdelay_s > 0 ? Math.Max(1, (int)Math.Round(syn.Tdelay_s / dt)) : 0;
            synapseStates[syn.Id] = new SynapseState
            {
                Model       = syn,
                DelaySteps  = delaySteps,
                DelayBuffer = delaySteps > 0 ? new double[delaySteps + 1] : Array.Empty<double>()
            };
        }

        // ── メインシミュレーションループ ─────────────────────────────
        for (double t = 0; t <= tEnd; t += dt)
        {
            result.TimeSteps.Add(t);
            var stepData = new SimulationDataPoint { Time = t };

            // ──────────────────────────────────────────────────────────
            // Step 1. 外部電流源 → ニューロンへ注入
            // ──────────────────────────────────────────────────────────
            foreach (var src in topology.ExternalSources)
            {
                double current = 0.0;
                if (t >= src.StartTime_s && t <= src.StartTime_s + src.Duration_s)
                {
                    double elapsed = t - src.StartTime_s;
                    current = src.I0_A + src.DeltaI_A * (elapsed / dt);

                    // 【欠落7 追加】サイン波モード
                    if (src.DeltaI_A == 0 && src.SineAmplitude_A != 0)
                    {
                        current = src.I0_A + src.SineAmplitude_A
                                  * Math.Sin(2.0 * Math.PI * src.SineFreq_Hz * elapsed);
                    }
                }

                // NodeOut / NodeIn 文字列で接続されているニューロンへ注入
                foreach (var n in topology.Neurons)
                {
                    if (!string.IsNullOrEmpty(src.NodeOut) && n.NodeIn == src.NodeOut)
                    {
                        neuronStates[n.Id].InjectedCurrentSum += current;
                    }
                }
                // Nets 経由の接続にも対応
                foreach (var net in topology.Nets)
                {
                    if (net.FromNodeId == src.Id)
                    {
                        if (neuronStates.ContainsKey(net.ToNodeId))
                            neuronStates[net.ToNodeId].InjectedCurrentSum += current;
                    }
                }
            }

            // ──────────────────────────────────────────────────────────
            // Step 2. ギャップジャンクション電流 (双方向)
            // ──────────────────────────────────────────────────────────
            foreach (var gj in topology.GapJunctions)
            {
                if (!neuronStates.ContainsKey(gj.Node1Id) || !neuronStates.ContainsKey(gj.Node2Id))
                    continue;

                var ns1  = neuronStates[gj.Node1Id];
                var ns2  = neuronStates[gj.Node2Id];
                double rGj = gj.Resistance_ohm > 0 ? gj.Resistance_ohm : 1e6;

                // 論文 4.3.4: i_gap = (V1 - V2) / R_gj  で双方向電流
                double igap = (ns1.MembraneVoltage - ns2.MembraneVoltage) / rGj;
                ns1.InjectedCurrentSum -= igap;
                ns2.InjectedCurrentSum += igap;
            }

            // ──────────────────────────────────────────────────────────
            // Step 3. シナプス＋軸索遅延処理
            // ──────────────────────────────────────────────────────────
            foreach (var syn in topology.Synapses)
            {
                var synState = synapseStates[syn.Id];

                double preVoltage = 0.0;
                if (!string.IsNullOrEmpty(syn.PreNodeId) && neuronStates.ContainsKey(syn.PreNodeId))
                    preVoltage = neuronStates[syn.PreNodeId].MembraneVoltage;

                // 【修正 Bug1】シフトレジスタ方式で遅延
                double delayedVoltage;
                if (synState.DelaySteps > 0 && synState.DelayBuffer.Length > 0)
                {
                    // バッファをひとつ右にシフト（[0]が最新入力、[n-1]が最古出力）
                    for (int i = synState.DelayBuffer.Length - 2; i >= 0; i--)
                        synState.DelayBuffer[i + 1] = synState.DelayBuffer[i];
                    synState.DelayBuffer[0] = preVoltage;
                    delayedVoltage = synState.DelayBuffer[synState.DelayBuffer.Length - 1];
                }
                else
                {
                    delayedVoltage = preVoltage; // 遅延なし
                }

                // シナプス電流計算
                // 【修正 Bug5】論文 4.3.2: I_syn = gm * (Vw - Vref) を正確に実装
                // Vw = Weight (結合荷重値電圧, 単位[V]), Vref = 基準電位
                double synCurrent = 0.0;
                if (delayedVoltage >= syn.Threshold_V)
                {
                    // 矩形型シナプス
                    double iSynMax = syn.Gm_S * (syn.Weight - syn.Vref_V);

                    if (syn.IsExponential && syn.TauR_s > 0)
                    {
                        // 指数立上り: i = I_max * (1 - exp(-t_rise / TauR))
                        synState.RiseTimer  += dt;
                        synState.DecayTimer  = 0.0;
                        synCurrent = iSynMax * (1.0 - Math.Exp(-synState.RiseTimer / syn.TauR_s));
                    }
                    else
                    {
                        synState.RiseTimer = 0.0;
                        synCurrent = iSynMax;
                    }
                }
                else
                {
                    // 論文のコード (4.3.2): flag==0 のとき指数立下り
                    if (syn.IsExponential && syn.TauD_s > 0 && synState.CurrentSynapticCurrent > 1e-15)
                    {
                        // decay_timer の初期値を電流連続性から算出
                        if (synState.RiseTimer > 0 && synState.DecayTimer == 0.0)
                        {
                            // 論文コード: t_decay = -TauD * log(i_synapse / I_SYNAPSE)
                            double iMax = syn.Gm_S * (syn.Weight - syn.Vref_V);
                            if (Math.Abs(iMax) > 1e-20)
                                synState.DecayTimer = -syn.TauD_s * Math.Log(
                                    Math.Abs(synState.CurrentSynapticCurrent / iMax));
                        }
                        synState.RiseTimer    = 0.0;
                        synState.DecayTimer  += dt;
                        double iMax2 = syn.Gm_S * (syn.Weight - syn.Vref_V);
                        synCurrent = iMax2 * Math.Exp(-synState.DecayTimer / syn.TauD_s);
                        if (Math.Abs(synCurrent) < 1e-15) synCurrent = 0.0;
                    }
                    else
                    {
                        synState.RiseTimer  = 0.0;
                        synState.DecayTimer = 0.0;
                        synCurrent = 0.0;
                    }
                }

                synState.CurrentSynapticCurrent = synCurrent;

                // 後段ニューロンへ注入
                if (!string.IsNullOrEmpty(syn.PostNodeId) && neuronStates.ContainsKey(syn.PostNodeId))
                    neuronStates[syn.PostNodeId].InjectedCurrentSum += synCurrent;

                // ── 【欠落6】STDP 重み更新 ──────────────────────────
                if (syn.EnableStdp && neuronStates.ContainsKey(syn.PreNodeId)
                                   && neuronStates.ContainsKey(syn.PostNodeId))
                {
                    var nsPost = neuronStates[syn.PostNodeId];
                    var nsPre  = neuronStates[syn.PreNodeId];

                    bool preSpiked  = nsPre.IsFiring  && nsPre.FireTimeElapsed  <= dt * 1.5;
                    bool postSpiked = nsPost.IsFiring  && nsPost.FireTimeElapsed <= dt * 1.5;

                    if (preSpiked)  synState.LastPreSpikeTime  = t;
                    if (postSpiked) synState.LastPostSpikeTime = t;

                    if ((preSpiked || postSpiked)
                        && !double.IsNegativeInfinity(synState.LastPreSpikeTime)
                        && !double.IsNegativeInfinity(synState.LastPostSpikeTime))
                    {
                        // dt_spike = t_pre - t_post  (論文符号定義)
                        double dtSpike = (preSpiked && postSpiked) ? 0.0
                                       : synState.LastPreSpikeTime - synState.LastPostSpikeTime;

                        double dW = 0.0;
                        double tauStdp = syn.TauD_s > 0 ? syn.TauD_s : 30e-6;
                        double lr      = syn.StdpLr;

                        // 非対称型STDP (論文 4.3.2, ASYM)
                        if (dtSpike > 0)
                            dW =  lr * Math.Exp(-Math.Abs(dtSpike) / tauStdp);
                        else if (dtSpike < 0)
                            dW = -lr * Math.Exp(-Math.Abs(dtSpike) / tauStdp);

                        syn.Weight += dW;
                        // 荷重値クランプ
                        if (syn.Weight > 2.0)  syn.Weight = 2.0;
                        if (syn.Weight < -2.0) syn.Weight = -2.0;
                    }
                }
            }

            // ──────────────────────────────────────────────────────────
            // Step 4. ニューロン膜電位更新
            // ──────────────────────────────────────────────────────────
            foreach (var kvp in neuronStates)
            {
                var id = kvp.Key;
                var ns = kvp.Value;
                var n  = ns.Model;

                double vdd = n.VDD_V > 0 ? n.VDD_V : 1.8;
                double tr  = n.Tr_s > 0   ? n.Tr_s   : 5e-6;
                double tk  = n.Tk_s > 0   ? n.Tk_s   : 10e-6;
                double tf  = n.Tf_s > 0   ? n.Tf_s   : 5e-6;

                bool didSpikeThisStep = false;

                if (ns.IsFiring)
                {
                    // ── 発火パルス波形生成フェーズ ──
                    ns.IsCharging = false;  // 発火中は充電フェーズではない
                    ns.FireTimeElapsed += dt;

                    if (ns.FireTimeElapsed <= tr)
                    {
                        // 立上り: Vout = Vreset + (Vdd - Vreset) / tr * t_fire
                        ns.MembraneVoltage = n.Vreset_V
                                           + (vdd - n.Vreset_V) * (ns.FireTimeElapsed / tr);
                    }
                    else if (ns.FireTimeElapsed <= tr + tk)
                    {
                        // 継続: Vout = Vdd
                        ns.MembraneVoltage = vdd;
                    }
                    else if (ns.FireTimeElapsed <= tr + tk + tf)
                    {
                        // 【修正 Bug4】立下り: Vdd → Vreset（Vreset=0以外でも正確）
                        ns.MembraneVoltage = vdd
                                           - ((vdd - n.Vreset_V) / tf)
                                             * (ns.FireTimeElapsed - (tr + tk));
                    }
                    else
                    {
                        // 発火パルス終了 → 不応期へ移行
                        ns.IsFiring               = false;
                        ns.FireTimeElapsed         = 0.0;
                        ns.IsInRefractory          = true;
                        ns.RefractoryTimeElapsed   = 0.0;
                        ns.MembraneVoltage         = n.Vreset_V;
                        ns.IsCharging              = false;
                    }
                }
                else
                {
                    // ── 非発火フェーズ（充電 or 不応期）──

                    // 【修正 Bug2】不応期中は RC更新を完全に停止し、膜電位を Vreset に固定
                    if (ns.IsInRefractory)
                    {
                        ns.MembraneVoltage = n.Vreset_V; // 固定

                        if (ns.RefractoryTimeElapsed <= n.Refractory_s)
                        {
                            // 指数関数的に閾値が元に戻る
                            double vNone = (vdd - n.Vth_V)
                                         * Math.Exp(-ns.RefractoryTimeElapsed / ns.TauRef);
                            ns.CurrentThreshold       = n.Vth_V + vNone;
                            ns.RefractoryTimeElapsed += dt;
                        }
                        else
                        {
                            // 不応期終了
                            ns.IsInRefractory        = false;
                            ns.RefractoryTimeElapsed = 0.0;
                            ns.CurrentThreshold      = n.Vth_V;
                            ns.IsCharging            = true;
                        }
                    }
                    else
                    {
                        // ── 充電フェーズ ──

                        // 【修正 Bug3】自励振電流は充電フェーズ中のみ注入
                        if (n.IsSelf && n.SelfPeriod_s > 0 && ns.IsCharging)
                        {
                            double tPulse  = tr + tk + tf;
                            double tCharge = n.SelfPeriod_s - tPulse;
                            if (tCharge > 0)
                            {
                                // 論文 式(2): I_self = C * Vth / T_charge
                                double iSelf = (n.C_F * n.Vth_V) / tCharge;
                                ns.InjectedCurrentSum += iSelf;
                            }
                        }

                        // RC並列回路モデル: C dV/dt = -V/R + I_in
                        double rC    = n.R_ohm * n.C_F;
                        double alpha = rC > 0 ? 1.0 / rC : 0.0;
                        double dV    = dt * (-ns.MembraneVoltage * alpha
                                            + ns.InjectedCurrentSum / n.C_F);
                        ns.MembraneVoltage += dV;

                        // 電圧クランプ [Vreset, Vdd]
                        if (ns.MembraneVoltage < n.Vreset_V) ns.MembraneVoltage = n.Vreset_V;
                        if (ns.MembraneVoltage > vdd)        ns.MembraneVoltage = vdd;

                        // 閾値判定 → 発火
                        if (ns.MembraneVoltage >= ns.CurrentThreshold)
                        {
                            ns.IsFiring       = true;
                            ns.FireTimeElapsed = 0.0;
                            ns.IsCharging      = false;
                            ns.SpikeCount++;
                            ns.LastSpikeTime  = t;
                            result.SpikeCounts[id]++;
                            didSpikeThisStep = true;
                        }
                    }
                }

                // 注入電流を消費（毎ステップリセット）
                ns.InjectedCurrentSum = 0.0;

                stepData.Voltages[id] = ns.MembraneVoltage;
                stepData.Spikes[id]   = didSpikeThisStep;
            }

            // シナプス電流を記録
            foreach (var kvp in synapseStates)
                stepData.Currents[kvp.Key] = kvp.Value.CurrentSynapticCurrent;

            result.Data.Add(stepData);
        }

        return result;
    }

    // -----------------------------------------------------------------------
    // プリセット回路
    // -----------------------------------------------------------------------

    public SnnNetworkTopology GetPresetTopology(string presetName)
    {
        var topology = new SnnNetworkTopology();

        if (presetName == "fig1")
        {
            topology.Neurons.Add(new NeuronModel { Id = "N1", X = 100, Y = 120, NodeOut = "net1" });
            topology.Neurons.Add(new NeuronModel { Id = "N2", X = 280, Y = 120, NodeIn = "net1", NodeOut = "net2" });
            topology.Neurons.Add(new NeuronModel { Id = "N2_copy", X = 460, Y = 120, NodeIn = "net2" });
            topology.ExternalSources.Add(new ExternalSourceModel
            {
                Id = "SRC1", X = 20, Y = 120, NodeOut = "net1",
                I0_A = 50e-6, StartTime_s = 5e-6, Duration_s = 50e-6
            });
            topology.Synapses.Add(new SynapseModel
            {
                Id = "SYN1", PreNodeId = "N1", PostNodeId = "N2",
                NetName = "net1", Gm_S = 10e-6, Weight = 1.9, Vref_V = 0.9,
                Threshold_V = 0.9, Tdelay_s = 20e-6
            });
            topology.Synapses.Add(new SynapseModel
            {
                Id = "SYN2", PreNodeId = "N2", PostNodeId = "N2_copy",
                NetName = "net2", Gm_S = 10e-6, Weight = 1.9, Vref_V = 0.9,
                Threshold_V = 0.9, Tdelay_s = 20e-6
            });
        }
        else if (presetName == "cpg")
        {
            // 相互抑制発振 CPG: N1<->N2 が抑制シナプスで交互発火
            topology.Neurons.Add(new NeuronModel
            {
                Id = "N1", X = 120, Y = 150,
                IsSelf = true, SelfPeriod_s = 40e-6
            });
            topology.Neurons.Add(new NeuronModel
            {
                Id = "N2", X = 320, Y = 150,
                IsSelf = true, SelfPeriod_s = 40e-6
            });
            topology.Synapses.Add(new SynapseModel
            {
                Id = "SYN_12", PreNodeId = "N1", PostNodeId = "N2",
                NetName = "net_inh1",
                Gm_S = 10e-6, Weight = -0.3, Vref_V = 0.9,
                Threshold_V = 0.9, Tdelay_s = 2e-6
            });
            topology.Synapses.Add(new SynapseModel
            {
                Id = "SYN_21", PreNodeId = "N2", PostNodeId = "N1",
                NetName = "net_inh2",
                Gm_S = 10e-6, Weight = -0.3, Vref_V = 0.9,
                Threshold_V = 0.9, Tdelay_s = 2e-6
            });
        }
        else if (presetName == "hopfield")
        {
            // ホップフィールド: 3ニューロン ギャップジャンクション結合
            topology.Neurons.Add(new NeuronModel { Id = "N1", X = 120, Y = 80 });
            topology.Neurons.Add(new NeuronModel { Id = "N2", X = 300, Y = 80 });
            topology.Neurons.Add(new NeuronModel { Id = "N3", X = 210, Y = 220 });

            topology.GapJunctions.Add(new GapJunctionModel
                { Id = "GJ12", Node1Id = "N1", Node2Id = "N2", Resistance_ohm = 500e3 });
            topology.GapJunctions.Add(new GapJunctionModel
                { Id = "GJ23", Node1Id = "N2", Node2Id = "N3", Resistance_ohm = 500e3 });
            topology.GapJunctions.Add(new GapJunctionModel
                { Id = "GJ31", Node1Id = "N3", Node2Id = "N1", Resistance_ohm = 500e3 });

            topology.ExternalSources.Add(new ExternalSourceModel
            {
                Id = "SRC1", X = 30, Y = 80, NodeOut = "net1",
                I0_A = 40e-6, StartTime_s = 5e-6, Duration_s = 30e-6
            });
            // SRC1 → N1 の接続
            topology.Neurons[0].NodeIn = "net1";
            topology.Nets.Add(new NetConnection { NetName = "net1", FromNodeId = "SRC1", ToNodeId = "N1" });
        }

        return topology;
    }
}
