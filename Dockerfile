FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

COPY *.csproj ./
RUN dotnet restore

COPY . .
RUN dotnet publish -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS final
WORKDIR /app
COPY --from=build /app/publish .

# wwwroot が無い場合にサブフォルダから自動補填
RUN if [ ! -d "wwwroot" ] && [ -d "卒研コード 1107/wwwroot" ]; then cp -r "卒研コード 1107/wwwroot" ./wwwroot; fi

ENV PORT=10000
EXPOSE 10000

ENTRYPOINT ["dotnet", "卒研コード 1107.dll"]
