import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import * as richFiles from "@integrations/misc/extract-file-content"
import * as textFiles from "@integrations/misc/read-text-file-window"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { Logger } from "@/shared/services/Logger"
import { createMockTaskConfig } from "../../../__tests__/helpers/mockTaskConfig"
import type { IWorkspaceTrait } from "../../../interfaces/IToolEnvironment"
import { buildWorkspaceTrait } from "../WorkspaceTraitBuilder"

describe("WorkspaceTraitBuilder ignore enforcement", () => {
	afterEach(() => sinon.restore())

	const file = path.resolve("credentials", "prod.txt")
	const readers: Array<{ name: string; read: (trait: IWorkspaceTrait, file: string) => Promise<unknown> }> = [
		{ name: "readFile", read: (trait, file) => trait.readFile(file) },
		{
			name: "readTextFileWindow",
			read: (trait, file) => trait.readTextFileWindow(file, {
				startLine: 1, maxSelectedBytes: 1024, maxRetainedLines: 10, maxRetainedBytes: 1024,
			}),
		},
		{ name: "countTextFileLines", read: (trait, file) => trait.countTextFileLines(file) },
		{ name: "readRichFile", read: (trait, file) => trait.readRichFile(file) },
	]

	function setup(allowed: boolean) {
		const validateAccess = sinon.stub().returns(allowed)
		const { config } = createMockTaskConfig({
			serviceOverrides: { diracIgnoreController: { validateAccess } as any },
		})
		const delegates = [
			sinon.stub(fs, "readFile").resolves("allowed"),
			sinon.stub(textFiles, "readTextFileWindow").resolves({} as any),
			sinon.stub(textFiles, "countTextFileLines").resolves(1),
			sinon.stub(richFiles, "extractFileContent").resolves({ text: "allowed" }),
		]
		return { trait: buildWorkspaceTrait(config), validateAccess, delegates }
	}

	for (const [index, reader] of readers.entries()) {
		it(`${reader.name} rejects before any content I/O`, async () => {
			const { trait, validateAccess, delegates } = setup(false)
			await assert.rejects(reader.read(trait, file), /blocked by the \.diracignore/)
			sinon.assert.calledOnceWithExactly(validateAccess, file)
			for (const delegate of delegates) sinon.assert.notCalled(delegate)
		})

		it(`${reader.name} delegates allowed reads and rechecks access on subsequent calls`, async () => {
			const { trait, validateAccess, delegates } = setup(true)
			await reader.read(trait, file)
			sinon.assert.calledOnce(delegates[index])
			validateAccess.returns(false)
			await assert.rejects(reader.read(trait, file), /blocked by the \.diracignore/)
			sinon.assert.calledTwice(validateAccess)
			sinon.assert.calledOnce(delegates[index])
		})
	}

	it("validates relative paths against the same cwd used by filesystem reads", async () => {
		const { trait, validateAccess, delegates } = setup(false)
		await assert.rejects(trait.readFile("credentials/../credentials/prod.txt"), /blocked by the \.diracignore/)
		sinon.assert.calledOnceWithExactly(validateAccess, file)
		for (const delegate of delegates) sinon.assert.notCalled(delegate)
	})

	it("keeps allowed attachments and per-file errors without reading ignored attachments", async () => {
		const logError = sinon.stub(Logger, "error")
		const directory = await fs.mkdtemp(path.join(tmpdir(), "dirac-attachment-ignore-"))
		try {
			const allowedFile = path.join(directory, "allowed.txt")
			const ignoredFile = path.join(directory, "prod notes.txt")
			await fs.writeFile(allowedFile, "Allowed attachment content")
			await fs.writeFile(ignoredFile, "SYNTHETIC_ATTACHMENT_CANARY")
			const validateAccess = sinon.stub().returns(true)
			validateAccess.withArgs(ignoredFile).returns(false)
			const { config } = createMockTaskConfig({
				serviceOverrides: { diracIgnoreController: { validateAccess } as any },
			})
			const readFile = sinon.spy(fs, "readFile")
			const trait = buildWorkspaceTrait(config)
			const result = await trait.formatAttachedFiles([
				allowedFile, ignoredFile, pathToFileURL(ignoredFile).href, "file:///%invalid",
			])
			assert.match(result, /Allowed attachment content/)
			assert.match(result, /blocked by the \.diracignore/)
			assert.match(result, /Invalid file URL/)
			assert.ok(!result.includes("SYNTHETIC_ATTACHMENT_CANARY"))
			sinon.assert.calledWithExactly(validateAccess, ignoredFile)
			sinon.assert.calledOnce(readFile)
			sinon.assert.calledThrice(logError)
			sinon.assert.calledWithExactly(readFile, allowedFile)
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("rejects image reads before constructing image blocks", async () => {
		const { trait, delegates } = setup(false)
		await assert.rejects(trait.readRichFile(path.resolve("credentials", "prod.png")), /blocked by the \.diracignore/)
		for (const delegate of delegates) sinon.assert.notCalled(delegate)
	})
})
