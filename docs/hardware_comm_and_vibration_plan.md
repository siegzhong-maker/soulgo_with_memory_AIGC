# 硬件通讯与震动模拟规划（App ↔ PC 模拟工具 ↔ 实体硬件）

> 本文在现有 `vibration_simulation_plan.md` 的 Web 震动方案基础上，扩展 App 与 PC 工具之间的蓝牙通讯，以及未来接入实体硬件的统一规划。目标是：**同一套“震动与反馈协议”，既能驱动 Web 动画，又能驱动 PC 模拟器和真实宠物硬件**。

## 1. 场景与目标

- 用户在 App 内完成一次「打卡 → 掉落场景/物品」行为时：
  - 已有：根据掉落等级 S/A/B/C，在 Web 端触发不同强度的视觉震动 + 文本提示 + `navigator.vibrate`。
  - 规划：同时向 PC 端「硬件模拟工具」发送统一的 **反馈事件**，用于：
    - 在 PC 工具 UI 中实时展示震动强度、灯效等模拟效果；
    - 在未来连接实体宠物硬件（如底座、玩偶）后，驱动真实马达/灯光。

整体链路：

App（业务事件源） ⇄ PC 工具（蓝牙网关 + 可视化模拟） ⇄ 实体硬件（马达/灯光执行）

---

## 2. 震动等级与模式（回顾与统一）

参考 `vibration_simulation_plan.md`，当前定义的等级与模式为：

| 等级 | CSS 动画类名   | 动画描述           | 文本提示示例                        | Web 物理震动 (ms)       |
| ---- | --------------- | ------------------ | ----------------------------------- | ------------------------ |
| S    | `shake-hard`    | 剧烈摇晃，稍长     | “📳 稀有信号接入！强力震动！”       | `[200, 100, 200, 100, 200]` |
| A    | `shake-medium`  | 明显摇晃           | “📳 发现优质信号，震动提示”         | `[200, 100, 200]`        |
| B    | `shake-soft`    | 轻微晃动           | “📳 获取普通信号”                   | `[200]`                  |
| C    | `shake-tiny`    | 极微小抖动或不动   | （可无提示或轻微提示）              | `[50]`                   |

本规划在此基础上做 **协议级抽象**：

- 将 `tier`（S/A/B/C）映射到统一的 **模式编号 `pattern_id`**，在 App / PC / 硬件侧共享同一张表，例如：
  - S → `pattern_id = 101`
  - A → `pattern_id = 102`
  - B → `pattern_id = 103`
  - C → `pattern_id = 104`
- 每个 `pattern_id` 对应一条完整的效果描述：
  - Web 动画类名（shake-hard / medium / soft / tiny）。
  - Web 端 `navigator.vibrate` 模式数组。
  - 硬件马达震动参数（占空比、频率、总时长等）。
  - 硬件灯光效果（颜色、闪烁节奏等，可选）。

这一映射表可以单独维护为 `vibration_patterns.json`，由 Web/PC/硬件三端共同引用。

---

## 3. 反馈事件模型（VibrationEvent）

### 3.1 字段定义

统一定义一条「反馈事件」结构，JSON 示例：

```json
{
  "version": "1.0",
  "event_type": "checkin_reward",
  "tier": "S",
  "pattern_id": 101,
  "timestamp": "2026-03-01T12:34:56.789Z",
  "duration_ms": 600,
  "repeat": 1,
  "meta": {
    "location": "武汉",
    "scene_id": "scene_egypt_pyramid",
    "item_name": "金字塔纪念雪花球",
    "user_id": "u_123456",
    "pet_id": "p_7890"
  }
}
```

说明：

- `version`：协议版本号，便于后续兼容。
- `event_type`：
  - `checkin_reward`：打卡掉落场景/物品。
  - `pet_interact`：宠物与用户互动（如被摸、完成任务）。
  - `system_notify`：系统级提示（如盲盒结果、奖励达成）。
- `tier`：S / A / B / C。
- `pattern_id`：对应 S/A/B/C 的震动模式编号，由映射表给出。
- `timestamp`：ISO 时间，可由 App 填入本机时间。
- `duration_ms`：建议震动总时长（对 PC/硬件可作为上限）。
- `repeat`：重复次数，默认为 1。
- `meta`：附加信息，不参与模式匹配，但方便 PC 工具 UI 展示与日志记录。

### 3.2 模式映射表（示意）

```json
[
  {
    "pattern_id": 101,
    "tier": "S",
    "web": {
      "css_class": "shake-hard",
      "vibrate": [200, 100, 200, 100, 200]
    },
    "hardware": {
      "motor": { "intensity": 1.0, "duration_ms": 600 },
      "led": { "color": "#FFD700", "blink_pattern": [200, 100, 200, 100, 200] }
    }
  },
  {
    "pattern_id": 102,
    "tier": "A",
    "web": {
      "css_class": "shake-medium",
      "vibrate": [200, 100, 200]
    },
    "hardware": {
      "motor": { "intensity": 0.7, "duration_ms": 400 },
      "led": { "color": "#FFA500", "blink_pattern": [200, 100, 200] }
    }
  }
]
```

---

## 4. App 侧集成点（从 Web 动画到蓝牙事件）

### 4.1 触发时机

在前端 `index.html` / `prototype.html` 中，当前已有：

- `getDroppedScene()`：返回包含 `tier`（S/A/B/C）的 `droppedScene` 对象；
- `showCheckinPreview(scene)`：展示打卡预览并启动震动动效。

集成策略：

1. 在 `showCheckinPreview(scene)` 内部：
   - 保留现有：
     - 根据 `scene.tier` 添加 `shake-*` CSS 类；
     - 展示中文提示文本；
     - 调用 `navigator.vibrate()`（如设备支持）。
   - 新增：
     - 构建一条 `VibrationEvent` 对象；
     - 通过蓝牙发送到 PC 工具（详见下一节）。

2. 如果 App 暂未连接 PC 工具：
   - 本地 UI 震动正常执行；
   - 蓝牙发送部分自动跳过或缓存（可计数重试，不强制要求在线）。

### 4.2 事件构建伪代码

```javascript
function buildVibrationEventFromScene(scene) {
  const tier = scene.tier || 'C';
  const patternId = mapTierToPatternId(tier); // S/A/B/C -> 101/102/103/104

  return {
    version: '1.0',
    event_type: 'checkin_reward',
    tier,
    pattern_id: patternId,
    timestamp: new Date().toISOString(),
    duration_ms: getSuggestedDurationMs(patternId),
    repeat: 1,
    meta: {
      location: scene.locationName || '',
      scene_id: scene.id || '',
      item_name: scene.displayName || '',
      user_id: getCurrentUserId(),
      pet_id: getCurrentPetId()
    }
  };
}
```

App 内部新增模块 `hardwareFeedbackBridge` 负责：

- 建立/维护与 PC 工具的蓝牙连接；
- 对外暴露统一方法 `sendVibrationEvent(event)`。

---

## 5. 蓝牙通讯设计（App ↔ PC 工具）

> 假设移动端为 iOS/Android App（或支持 BLE 的 Web App），PC 上运行一个原生/桌面工具，双方通过 **BLE GATT** 协议通讯。

### 5.1 GATT Service 设计

定义一个 **PetFeedbackService**，包括两个核心特征值：

- **Service UUID**：`PET_FEEDBACK_SERVICE_UUID`（示例 `0000ffee-0000-1000-8000-00805f9b34fb`，实际需分配具体 UUID）。

1. 特征：`feedback_command`（Write）
   - UUID：`PET_FEEDBACK_COMMAND_UUID`。
   - 方向：App → PC。
   - 数据类型：
     - 建议 JSON 文本（UTF-8 编码）或 TLV 编码的小二进制结构。
   - 内容：上文定义的 `VibrationEvent`。

2. 特征：`feedback_status`（Notify）
   - UUID：`PET_FEEDBACK_STATUS_UUID`。
   - 方向：PC → App。
   - 用途：
     - 通知 App 当前硬件/模拟器状态。
     - 回执某条事件是否已处理。

`feedback_status` JSON 示例：

```json
{
  "version": "1.0",
  "status": "ok",
  "last_event_pattern_id": 101,
  "hardware_online": true,
  "simulator_mode": "simulation_only"
}
```

### 5.2 连接角色

- **移动端 App**：GATT Client。
  - 扫描并连接 PC 工具广播的 BLE 设备（例如设备名 `SoulGo-PC-Gateway`）。
  - 发现 `PetFeedbackService`，写入 `feedback_command`，订阅 `feedback_status`。

- **PC 模拟工具**：GATT Server。
  - 通过本地蓝牙适配器对外发布 `PetFeedbackService`。
  - 接收 `feedback_command` 写入事件，在本地 UI 中渲染模拟效果，并转发给实体硬件（如已连接）。

### 5.3 通讯流程（文字时序）

1. 用户在 App 内完成一次打卡 → 获得 `scene` + `tier`。
2. App：
   - 执行 Web 层 UI 震动：
     - 添加 `shake-*` CSS 类；
     - 显示中文提示；
     - 调 `navigator.vibrate()`（如果支持）。
   - 构建 `VibrationEvent`。
   - 若已连接 PC：
     - 将 `VibrationEvent` JSON 写入 `feedback_command`。
3. PC 工具（BLE Server）：
   - 收到事件 → 解析 JSON。
   - 在工具 UI 中：
     - 展示一条事件日志（地点、等级、时间等）；
     - 在“震动可视化区域”播放对应强度动画（可与 Web CSS shake 对齐）。
   - 若 PC 还连接了实体硬件：
     - 将事件转换为硬件指令，发送给玩偶/底座。
   - 写回 `feedback_status` 通知 App 当前状态（可选）。

---

## 6. PC 模拟工具设计（UI & 逻辑）

### 6.1 UI 模块

PC 工具基本界面建议由以下区域组成：

1. **连接状态栏**
   - 显示：
     - App 连接状态（已连接/未连接）。
     - 实体硬件状态（离线/模拟模式/直连模式）。
   - 简单指示灯 + 文案即可。

2. **震动可视化区域**
   - 以“宠物玩偶”或“物品卡片”的插画为主体。
   - 不同 `pattern_id` 映射到不同的震动效果：
     - S：整体剧烈摇晃 + 强光/色块闪烁。
     - A：明显摇晃。
     - B：轻微晃动。
     - C：几乎静止，仅做轻微亮度变化。

3. **事件日志面板**
   - 按时间倒序列出最近若干条 `VibrationEvent`：
     - 时间、地点、等级、物品名、是否已下发到硬件等。
   - 支持简单过滤（仅 S 级 / 仅失败等）。

4. **测试与调试面板**
   - 提供手动触发按钮（S/A/B/C 测试）。
   - 允许在 **模拟模式** 下即使没有 App 也能测试硬件或 UI。

### 6.2 模式切换

PC 工具应支持两种工作模式：

- **Simulation Only（仅模拟模式）**
  - 不连接实体硬件，仅在 PC UI 中展示震动。
  - 适用于早期开发和演示。

- **Hardware Bridge（硬件直连模式）**
  - 与实体宠物硬件建立串口 / 自定义蓝牙连接。
  - 将从 App 收到的 `VibrationEvent` 转换为硬件指令。

模式状态通过 `feedback_status.hardware_online` 与 `simulator_mode` 字段回传给 App，App 可以据此在 UI 中增加简单提示（如“已连接宠物底座，震动同步中”）。

---

## 7. 实体硬件接口规划（概念级）

> 本节只做协议框架设计，具体电路与固件实现由硬件团队决定。

### 7.1 硬件指令抽象

无论 PC ↔ 硬件使用的是串口、USB HID 或蓝牙，建议统一一条「硬件反馈指令」结构：

```json
{
  "cmd": "vibrate",
  "pattern_id": 101,
  "motor": { "intensity": 1.0, "duration_ms": 600 },
  "led": { "color": "#FFD700", "blink_pattern": [200, 100, 200, 100, 200] }
}
```

或在更低层以二进制帧编码，但语义保持对应：

- `pattern_id`：与 App/PC 共用。
- `motor.intensity`：0.0–1.0，马达强度。
- `motor.duration_ms`：总震动时长。
- `led`：可选，若硬件具备灯光。

### 7.2 安全与容错

- PC 工具应限制连续高强度震动，防止硬件过热：
  - 如：S 级 pattern 连续触发时加锁冷却 5–10 秒。
- 当硬件不在线或异常：
  - PC 工具仍然在 UI 中执行模拟效果；
  - 不向硬件发送指令；
  - 通过 `feedback_status` 通知 App“仅模拟模式启用”。

---

## 8. 与现有 Web 震动方案的关系

- **保持兼容**：现有 `vibration_simulation_plan.md` 中的 CSS 与 `navigator.vibrate` 实现可以完全保留。
- **增加一个“输出端”**：
  - 原有：事件 → Web UI 震动。
  - 新增：事件 → 构建 `VibrationEvent` → 蓝牙发往 PC 工具。
- 整体不改变 Web 端对用户的体验，只是同步多了一个“外部回响”通道。

---

## 9. 实施步骤（建议）

1. **定义协议与模式表**
   - 在代码库中增加 `vibration_patterns.json` 与 `VibrationEvent` Type 定义。
   - 在 Web 端创建 `hardwareFeedbackBridge` 模块（先只打印日志，方便调试）。

2. **扩展 Web 端逻辑**
   - 修改 `showCheckinPreview`：
     - 使用 `mapTierToPatternId` 构建 `VibrationEvent`；
     - 调用 `hardwareFeedbackBridge.sendVibrationEvent(event)`。

3. **实现 PC 模拟工具最小版本**
   - 优先跑通：
     - 收到 App 发来的 JSON；
     - 在 UI 上按等级渲染不同震动动画；
     - 返回简单的 `feedback_status`。
   - 早期可先通过 WebSocket/HTTP 通道模拟，将 BLE 接入留到后续。

4. **接入 BLE 与实体硬件**
   - PC 工具注册 `PetFeedbackService` GATT 服务；
   - 确认 App BLE Client 能发现并写入数据；
   - 与硬件团队对齐指令结构，打通端到端闭环。

通过以上设计，即可逐步从“纯 Web 动画 → PC 震动模拟 → 真实宠物硬件震动”平滑演进，而无需频繁改动上层业务逻辑和文案。

