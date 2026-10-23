import OBSWebSocket from 'obs-websocket-js'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

type StoredObsConfig = { port?: number; password?: string }

export class ObsController {
  private client = new OBSWebSocket()
  private connected = false
  private connecting: Promise<void> | null = null
  private lastError = ''
  private readonly configPath = resolve(import.meta.dirname, '../data/obs-connection.json')
  private port = 4455
  private url = process.env.OBS_WEBSOCKET_URL || 'ws://127.0.0.1:4455'
  private password = process.env.OBS_WEBSOCKET_PASSWORD || undefined

  constructor() {
    try {
      const saved = JSON.parse(readFileSync(this.configPath, 'utf8')) as StoredObsConfig
      if (Number.isInteger(saved.port) && Number(saved.port) >= 1 && Number(saved.port) <= 65535) this.port = Number(saved.port)
      if (typeof saved.password === 'string') this.password = saved.password || undefined
      this.url = `ws://127.0.0.1:${this.port}`
    } catch {
      const configuredPort = Number(new URL(this.url).port || 4455)
      if (Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535) this.port = configuredPort
    }
    this.attachClientEvents()
  }

  private attachClientEvents() {
    this.client.on('ConnectionClosed', () => { this.connected = false })
    this.client.on('ConnectionError', (error) => { this.connected = false; this.lastError = error.message })
  }

  connectionSettings() {
    return { port: this.port, password_configured: Boolean(this.password) }
  }

  async updateConnectionSettings(port: number, password: string | undefined, clearPassword: boolean) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ポートは1〜65535で入力してください。')
    if (password && password.length > 256) throw new Error('パスワードは256文字以内で入力してください。')
    const nextPassword = clearPassword ? undefined : password ? password : this.password
    mkdirSync(dirname(this.configPath), { recursive: true })
    writeFileSync(this.configPath, JSON.stringify({ port, password: nextPassword || '' }, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(this.configPath, 0o600) } catch { /* Windows ACLs control access on Windows. */ }

    try { await this.client.disconnect() } catch { /* The socket may already be closed. */ }
    this.client = new OBSWebSocket()
    this.connected = false
    this.connecting = null
    this.lastError = ''
    this.port = port
    this.url = `ws://127.0.0.1:${port}`
    this.password = nextPassword
    this.attachClientEvents()

    const status = await this.status()
    return { ...this.connectionSettings(), ...status }
  }

  async connect() {
    if (this.connected) return
    if (this.connecting) return this.connecting
    this.connecting = this.client.connect(this.url, this.password)
      .then(() => { this.connected = true; this.lastError = '' })
      .catch((error: Error) => { this.connected = false; this.lastError = error.message; throw error })
      .finally(() => { this.connecting = null })
    return this.connecting
  }

  async status() {
    try {
      await this.connect()
      const current = await this.client.call('GetCurrentProgramScene')
      return { online: true, current_scene: current.currentProgramSceneName, error: '' }
    } catch {
      return { online: false, current_scene: '', error: this.lastError || 'OBS WebSocketに接続できません。' }
    }
  }

  async scenes() {
    await this.connect()
    const result = await this.client.call('GetSceneList')
    return result.scenes.map((scene) => scene.sceneName)
  }

  async switchScene(sceneName: string) {
    const scenes = await this.scenes()
    if (!scenes.includes(sceneName)) throw new Error(`OBSに「${sceneName}」シーンがありません。`)
    await this.client.call('SetCurrentProgramScene', { sceneName })
    return { success: true, current_scene: sceneName }
  }

  async setText(inputName: string, text: string) {
    await this.connect()
    const inputs = await this.client.call('GetInputList')
    if (!inputs.inputs.some((input) => input.inputName === inputName)) {
      throw new Error(`OBSに「${inputName}」ソースがありません。`)
    }
    await this.client.call('SetInputSettings', { inputName, inputSettings: { text }, overlay: true })
  }

  onMediaEnded(callback: (inputName: string) => void) {
    this.client.on('MediaInputPlaybackEnded', (event) => callback(event.inputName))
  }

  async playMedia(inputName: string, localFile: string) {
    await this.connect()
    const inputs = await this.client.call('GetInputList')
    if (!inputs.inputs.some((input) => input.inputName === inputName)) throw new Error(`OBSに「${inputName}」メディアソースがありません。`)
    await this.client.call('SetInputSettings', { inputName, inputSettings: { local_file: localFile, looping: false }, overlay: true })
    await this.client.call('TriggerMediaInputAction', { inputName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' })
  }

  async stopMedia(inputName: string) {
    if (!this.connected) return
    await this.client.call('TriggerMediaInputAction', { inputName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' })
  }

  async publishText(values: Record<string, string>) {
    const entries = Object.entries(values).filter(([source]) => source.trim())
    for (const [source, text] of entries) await this.setText(source, text)
    return { success: true, updated: entries.map(([source]) => source) }
  }
}
