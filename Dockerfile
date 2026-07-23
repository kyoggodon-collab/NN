FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

# プロジェクトファイルをコピーして復元
COPY ["卒研コード 1107/卒研コード 1107.csproj", "卒研コード 1107/"]
RUN dotnet restore "卒研コード 1107/卒研コード 1107.csproj"

# ソースコードをコピーしてビルド・パブリッシュ
COPY . .
WORKDIR "/src/卒研コード 1107"
RUN dotnet publish "卒研コード 1107.csproj" -c Release -o /app/publish

# 実行環境イメージ
FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS final
WORKDIR /app
COPY --from=build /app/publish .

ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080

ENTRYPOINT ["dotnet", "卒研コード 1107.dll"]
