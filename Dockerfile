FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

# .csproj ファイルを自動検出してパッケージ復元
COPY *.csproj ./
RUN dotnet restore

# すべてのソースコードをコピーしてビルド・パブリッシュ
COPY . .
RUN dotnet publish -c Release -o /app/publish

# 実行環境イメージ
FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS final
WORKDIR /app
COPY --from=build /app/publish .

ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080

ENTRYPOINT ["dotnet", "卒研コード 1107.dll"]
