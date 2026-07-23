using System.Text.Json.Serialization;

namespace SnnEditor;

public class NeuronModel
{
    [JsonPropertyName("Id")]
    public string Id { get; set; } = "N1";

    [JsonPropertyName("X")]
    public double X { get; set; } = 100;

    [JsonPropertyName("Y")]
    public double Y { get; set; } = 100;

    [JsonPropertyName("NodeIn")]
    public string NodeIn { get; set; } = "";

    [JsonPropertyName("NodeOut")]
    public string NodeOut { get; set; } = "";

    [JsonPropertyName("C_F")]
    public double C_F { get; set; } = 400e-15; // 400 fF

    [JsonPropertyName("R_ohm")]
    public double R_ohm { get; set; } = 50e6; // 50 MΩ

    [JsonPropertyName("Vth_V")]
    public double Vth_V { get; set; } = 0.30; // 0.3 V

    [JsonPropertyName("Vreset_V")]
    public double Vreset_V { get; set; } = 0.00; // 0 V

    [JsonPropertyName("VDD_V")]
    public double VDD_V { get; set; } = 1.80; // 1.8 V

    [JsonPropertyName("Refractory_s")]
    public double Refractory_s { get; set; } = 2e-3; // 2 ms

    [JsonPropertyName("Tr_s")]
    public double Tr_s { get; set; } = 5e-6; // 5 µs

    [JsonPropertyName("Tf_s")]
    public double Tf_s { get; set; } = 5e-6; // 5 µs

    [JsonPropertyName("Tk_s")]
    public double Tk_s { get; set; } = 10e-6; // 10 µs

    [JsonPropertyName("IsSelf")]
    public bool IsSelf { get; set; } = false;

    [JsonPropertyName("SelfPeriod_s")]
    public double SelfPeriod_s { get; set; } = 50e-6; // 50 µs
}

public class ExternalSourceModel
{
    [JsonPropertyName("Id")]
    public string Id { get; set; } = "SRC1";

    [JsonPropertyName("X")]
    public double X { get; set; } = 50;

    [JsonPropertyName("Y")]
    public double Y { get; set; } = 100;

    [JsonPropertyName("NodeOut")]
    public string NodeOut { get; set; } = "";

    [JsonPropertyName("I0_A")]
    public double I0_A { get; set; } = 50e-6; // 50 µA

    [JsonPropertyName("DeltaI_A")]
    public double DeltaI_A { get; set; } = 0.0; // A/step

    // 【欠落7 対応】サイン波モード
    [JsonPropertyName("SineAmplitude_A")]
    public double SineAmplitude_A { get; set; } = 0.0; // サイン波振幅 [A]

    [JsonPropertyName("SineFreq_Hz")]
    public double SineFreq_Hz { get; set; } = 20e3; // サイン波周波数 [Hz]

    [JsonPropertyName("StartTime_s")]
    public double StartTime_s { get; set; } = 5e-6; // 5 µs

    [JsonPropertyName("Duration_s")]
    public double Duration_s { get; set; } = 50e-6; // 50 µs
}

public class SynapseModel
{
    [JsonPropertyName("Id")]
    public string Id { get; set; } = "SYN1";

    [JsonPropertyName("PreNodeId")]
    public string PreNodeId { get; set; } = "";

    [JsonPropertyName("PostNodeId")]
    public string PostNodeId { get; set; } = "";

    [JsonPropertyName("NetName")]
    public string NetName { get; set; } = "net1";

    [JsonPropertyName("Gm_S")]
    public double Gm_S { get; set; } = 10e-6; // 10 µS

    // Weight = Vw [V]: 論文定義の結合荷重値電圧。I_syn = gm * (Vw - Vref)
    [JsonPropertyName("Weight")]
    public double Weight { get; set; } = 1.9; // Vw [V], 通常 Vref < Vw < Vdd

    [JsonPropertyName("Vref_V")]
    public double Vref_V { get; set; } = 0.9; // 基準電圧 Vref [V]

    [JsonPropertyName("Threshold_V")]
    public double Threshold_V { get; set; } = 0.9; // 0.9 V

    [JsonPropertyName("Tdelay_s")]
    public double Tdelay_s { get; set; } = 20e-6; // 20 µs delay (Axon)

    [JsonPropertyName("IsExponential")]
    public bool IsExponential { get; set; } = false;

    [JsonPropertyName("TauR_s")]
    public double TauR_s { get; set; } = 1e-6; // 1 µs

    [JsonPropertyName("TauD_s")]
    public double TauD_s { get; set; } = 1e-6; // 1 µs

    [JsonPropertyName("EnableStdp")]
    public bool EnableStdp { get; set; } = false;

    [JsonPropertyName("StdpLr")]
    public double StdpLr { get; set; } = 0.01;
}

public class GapJunctionModel
{
    [JsonPropertyName("Id")]
    public string Id { get; set; } = "GJ1";

    [JsonPropertyName("Node1Id")]
    public string Node1Id { get; set; } = "";

    [JsonPropertyName("Node2Id")]
    public string Node2Id { get; set; } = "";

    [JsonPropertyName("NetName")]
    public string NetName { get; set; } = "net_gj1";

    [JsonPropertyName("Resistance_ohm")]
    public double Resistance_ohm { get; set; } = 1e6; // 1 MΩ
}

public class NetConnection
{
    [JsonPropertyName("NetName")]
    public string NetName { get; set; } = "net1";

    [JsonPropertyName("FromNodeId")]
    public string FromNodeId { get; set; } = "";

    [JsonPropertyName("ToNodeId")]
    public string ToNodeId { get; set; } = "";
}

public class SnnNetworkTopology
{
    [JsonPropertyName("Neurons")]
    public List<NeuronModel> Neurons { get; set; } = new();

    [JsonPropertyName("ExternalSources")]
    public List<ExternalSourceModel> ExternalSources { get; set; } = new();

    [JsonPropertyName("Synapses")]
    public List<SynapseModel> Synapses { get; set; } = new();

    [JsonPropertyName("GapJunctions")]
    public List<GapJunctionModel> GapJunctions { get; set; } = new();

    [JsonPropertyName("Nets")]
    public List<NetConnection> Nets { get; set; } = new();
}

public class SimulationConfig
{
    [JsonPropertyName("T_end_s")]
    public double T_end_s { get; set; } = 100e-6; // 100 µs

    [JsonPropertyName("dt_s")]
    public double dt_s { get; set; } = 30e-9; // 30 ns
}

public class SimulationDataPoint
{
    [JsonPropertyName("t")]
    public double Time { get; set; }

    [JsonPropertyName("voltages")]
    public Dictionary<string, double> Voltages { get; set; } = new();

    [JsonPropertyName("currents")]
    public Dictionary<string, double> Currents { get; set; } = new();

    [JsonPropertyName("spikes")]
    public Dictionary<string, bool> Spikes { get; set; } = new();
}

public class SimulationResult
{
    [JsonPropertyName("timeSteps")]
    public List<double> TimeSteps { get; set; } = new();

    [JsonPropertyName("data")]
    public List<SimulationDataPoint> Data { get; set; } = new();

    [JsonPropertyName("spikeCounts")]
    public Dictionary<string, int> SpikeCounts { get; set; } = new();
}
