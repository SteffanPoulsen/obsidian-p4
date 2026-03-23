import { App, PluginSettingTab, Setting } from "obsidian";
import type P4Plugin from "./main";

export interface P4PluginSettings {
	useP4Config: boolean;
	p4Port: string;
	p4Client: string;
	p4User: string;
}

export const DEFAULT_SETTINGS: P4PluginSettings = {
	useP4Config: true,
	p4Port: "",
	p4Client: "",
	p4User: "",
};

export class P4SettingTab extends PluginSettingTab {
	plugin: P4Plugin;

	constructor(app: App, plugin: P4Plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Perforce Integration" });

		new Setting(containerEl)
			.setName("Use .p4config")
			.setDesc(
				"Read connection settings from a .p4config file in the vault root. " +
				"When enabled, manual settings below are ignored."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useP4Config)
					.onChange(async (value) => {
						this.plugin.settings.useP4Config = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (!this.plugin.settings.useP4Config) {
			new Setting(containerEl)
				.setName("Server")
				.setDesc("P4PORT — server address (e.g. ssl:p4.example.com:1666)")
				.addText((text) =>
					text
						.setPlaceholder("ssl:server:1666")
						.setValue(this.plugin.settings.p4Port)
						.onChange(async (value) => {
							this.plugin.settings.p4Port = value;
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName("Workspace")
				.setDesc("P4CLIENT — the Perforce workspace (client) name")
				.addText((text) =>
					text
						.setPlaceholder("my-workspace")
						.setValue(this.plugin.settings.p4Client)
						.onChange(async (value) => {
							this.plugin.settings.p4Client = value;
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName("User")
				.setDesc("P4USER — Perforce username")
				.addText((text) =>
					text
						.setPlaceholder("username")
						.setValue(this.plugin.settings.p4User)
						.onChange(async (value) => {
							this.plugin.settings.p4User = value;
							await this.plugin.saveSettings();
						})
				);
		}
	}
}
