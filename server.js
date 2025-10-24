require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(__dirname));

let anthropic = null;
let mcpClient = null;

async function initializeMCP() {
    const transport = new StdioClientTransport({
        command: 'npx',
        args: ['-y', '@amap/amap-maps-mcp-server'],
        env: {
            ...process.env,
            AMAP_MAPS_API_KEY: process.env.AMAP_MAPS_API_KEY
        }
    });

    mcpClient = new Client({
        name: 'map-navigator-client',
        version: '1.0.0'
    }, {
        capabilities: {}
    });

    await mcpClient.connect(transport);
    console.log('✅ MCP Client connected to AMap MCP Server');

    const tools = await mcpClient.listTools();
    console.log('Available AMap MCP tools:', tools.tools.map(t => t.name).join(', '));
}

function initializeAnthropic() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }
    const config = { apiKey };
    if (process.env.ANTHROPIC_BASE_URL) {
        config.baseURL = process.env.ANTHROPIC_BASE_URL;
    }
    anthropic = new Anthropic(config);
    console.log('✅ Anthropic client initialized');
}

function openBrowserURL(url) {
    const platform = process.platform;
    let command;

    if (platform === 'darwin') {
        command = `open "${url}"`;
    } else if (platform === 'win32') {
        command = `start "${url}"`;
    } else {
        command = `xdg-open "${url}"`;
    }

    return new Promise((resolve, reject) => {
        exec(command, (error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

async function reverseGeocode(lng, lat) {
    try {
        const apiKey = process.env.AMAP_MAPS_API_KEY;
        if (!apiKey) {
            throw new Error('AMAP_MAPS_API_KEY not configured');
        }

        const url = `https://restapi.amap.com/v3/geocode/regeo?key=${apiKey}&location=${lng},${lat}&output=json`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.status === '1' && data.regeocode) {
            const regeocode = data.regeocode;
            return {
                name: regeocode.formatted_address,
                location: `${lng},${lat}`,
                adcode: regeocode.addressComponent.adcode,
                address: regeocode.formatted_address
            };
        }

        return null;
    } catch (error) {
        console.error('逆地理编码失败:', error);
        return null;
    }
}

async function searchLocation(keyword) {
    try {
        const apiKey = process.env.AMAP_MAPS_API_KEY;
        if (!apiKey) {
            throw new Error('AMAP_MAPS_API_KEY not configured');
        }

        const url = `https://restapi.amap.com/v3/place/text?key=${apiKey}&keywords=${encodeURIComponent(keyword)}&output=json`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.status === '1' && data.pois && data.pois.length > 0) {
            const poi = data.pois[0];
            return {
                name: poi.name,
                location: poi.location,
                adcode: poi.adcode,
                address: poi.address || poi.pname + poi.cityname + poi.adname
            };
        }

        const geocodeUrl = `https://restapi.amap.com/v3/geocode/geo?key=${apiKey}&address=${encodeURIComponent(keyword)}&output=json`;
        const geocodeResponse = await fetch(geocodeUrl);
        const geocodeData = await geocodeResponse.json();

        if (geocodeData.status === '1' && geocodeData.geocodes && geocodeData.geocodes.length > 0) {
            const geocode = geocodeData.geocodes[0];
            return {
                name: geocode.formatted_address || keyword,
                location: geocode.location,
                adcode: geocode.adcode,
                address: geocode.formatted_address || keyword
            };
        }

        return null;
    } catch (error) {
        console.error('搜索地点失败:', error);
        return null;
    }
}

app.post('/api/navigate', async (req, res) => {
    const { input, userLocation } = req.body;

    if (!input) {
        return res.status(400).json({ success: false, error: '请输入导航需求' });
    }

    try {
        const prompt = `从以下用户输入中提取起点和终点信息，以JSON格式返回：{"from": "起点", "to": "终点"}

用户输入：${input}

如果用户没有明确指定起点（例如只说"去xxx"、"到xxx"），请将from字段设置为null。
请只返回JSON，不要有其他说明文字。`;

        const response = await anthropic.messages.create({
            model: process.env.ANTHROPIC_MODEL || 'claude-4.5-sonnet',
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }]
        });

        const textContent = response.content.find(block => block.type === 'text');
        const jsonMatch = textContent.text.match(/\{[^}]+\}/);

        if (!jsonMatch) {
            throw new Error('无法解析地点信息');
        }

        const locations = JSON.parse(jsonMatch[0]);
        console.log('提取的地点:', locations);

        let fromInfo = null;

        if (locations.from && locations.from !== 'null') {
            console.log('正在搜索起点信息...');
            fromInfo = await searchLocation(locations.from);
        } else if (userLocation) {
            console.log('使用用户当前位置作为起点:', userLocation);
            fromInfo = await reverseGeocode(userLocation.lng, userLocation.lat);
        } else {
            throw new Error('未获取到您的位置信息,请明确指定起点(例如:从xx到yy)或允许浏览器获取位置权限');
        }

        console.log('正在搜索终点信息...');
        const toInfo = await searchLocation(locations.to);

        if (!toInfo) {
            throw new Error('无法找到终点信息，请使用更具体的地址');
        }

        if (!fromInfo) {
            throw new Error('无法找到起点信息，请使用更具体的地址');
        }

        console.log('起点信息:', fromInfo);
        console.log('终点信息:', toInfo);

        const fromLngLat = fromInfo.location;
        const toLngLat = toInfo.location;

        const amapURL = `https://www.amap.com/dir?dateTime=now` +
            `&from[adcode]=${fromInfo.adcode}` +
            `&from[id]=` +
            `&from[lnglat]=${fromLngLat}` +
            `&from[modxy]=${fromLngLat}` +
            `&from[name]=${fromInfo.name}` +
            `&from[poitype]=` +
            `&to[adcode]=${toInfo.adcode}` +
            `&to[id]=` +
            `&to[lnglat]=${toLngLat}` +
            `&to[modxy]=${toLngLat}` +
            `&to[name]=${toInfo.name}` +
            `&to[poitype]=` +
            `&policy=1&type=car`;

        console.log('打开URL:', amapURL);
        await openBrowserURL(amapURL);

        res.json({
            success: true,
            message: `导航已启动！正在规划路线：${fromInfo.name} → ${toInfo.name}`,
            from: fromInfo.name,
            to: toInfo.name,
            map: '高德地图'
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({
            success: false,
            error: error.message || '处理请求时出错'
        });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

async function startServer() {
    try {
        initializeAnthropic();
        await initializeMCP();

        app.listen(PORT, () => {
            console.log(`\n🚀 Server running at http://localhost:${PORT}`);
            console.log(`📍 Open this URL in your browser to start navigating!\n`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

process.on('SIGINT', () => {
    console.log('\n👋 Shutting down...');
    process.exit(0);
});

startServer();
