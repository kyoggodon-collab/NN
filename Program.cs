using SnnEditor;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<SnnSimulationEngine>();

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapPost("/api/simulation/run", (SimulationRequest request, SnnSimulationEngine engine) =>
{
    var topology = request.Topology ?? new SnnNetworkTopology();
    var config = request.Config ?? new SimulationConfig();
    
    var result = engine.RunSimulation(topology, config);
    return Results.Ok(result);
});

app.MapGet("/api/network/preset/{name}", (string name, SnnSimulationEngine engine) =>
{
    var topology = engine.GetPresetTopology(name.ToLower());
    return Results.Ok(topology);
});

Console.WriteLine("SNN GUI Server Started on http://localhost:5000");

app.Run("http://localhost:5000");

public record SimulationRequest(SnnNetworkTopology? Topology, SimulationConfig? Config);
