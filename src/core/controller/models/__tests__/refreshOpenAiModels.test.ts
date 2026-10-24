import { afterEach, describe, it } from "mocha"
import "should"
import { openAiModelInfoSaneDefaults } from "@shared/api"
import { OpenAiModelsRequest } from "@shared/proto/dirac/models"
import axios, { HttpStatusCode } from "axios"
import sinon from "sinon"
import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import { classifyOpenAiModelsError, getOpenAiModels, refreshOpenAiModels } from "../refreshOpenAiModels"

describe("refreshOpenAiModels", () => {
	afterEach(() => sinon.restore())

	it("normalizes /chat/completions and /responses suffixes and deduplicates returned model IDs", async () => {
		const get = sinon.stub(axios, "get").resolves({
			data: { data: [{ id: "model-alpha" }, { id: "model-alpha" }, { id: "" }, {}] },
		})

		const result = await refreshOpenAiModels(
			undefined,
			OpenAiModelsRequest.create({
				baseUrl: "https://provider.example/v1/chat/completions/",
				apiKey: "test-key",
			}),
		)

		result.values.should.deepEqual(["model-alpha"])
		sinon.assert.calledOnceWithExactly(
			get,
			"https://provider.example/v1/models",
			sinon.match({
				headers: { Authorization: "Bearer test-key" },
				timeout: 5000,
			}),
		)
	})

	it("returns empty models without making network requests when baseUrl is empty", async () => {
		const get = sinon.stub(axios, "get")

		const models = await getOpenAiModels({ baseUrl: "", apiKey: "sk-test" })

		models.should.deepEqual({})
		sinon.assert.notCalled(get)
	})

	it("retries /v1/models when /models returns 404 and baseUrl omits /v1", async () => {
		const get = sinon.stub(axios, "get")
		get.withArgs("http://localhost:11434/models", sinon.match.any).rejects({
			isAxiosError: true,
			response: { status: HttpStatusCode.NotFound },
		})
		get.withArgs("http://localhost:11434/v1/models", sinon.match.any).resolves({
			data: { data: [{ id: "qwen2.5-coder:32b" }] },
		})

		const result = await refreshOpenAiModels(undefined, OpenAiModelsRequest.create({ baseUrl: "http://localhost:11434" }))

		result.values.should.deepEqual(["qwen2.5-coder:32b"])
		sinon.assert.calledTwice(get)
	})

	it("does not retry /v1/models when baseUrl already ends with /v1 and returns 404", async () => {
		const warn = sinon.stub(Logger, "warn")
		const error = sinon.stub(Logger, "error")
		const get = sinon.stub(axios, "get").rejects({
			isAxiosError: true,
			response: { status: HttpStatusCode.NotFound },
		})

		const result = await refreshOpenAiModels(
			undefined,
			OpenAiModelsRequest.create({ baseUrl: "https://provider.example/v1" }),
		)

		result.values.should.deepEqual([])
		sinon.assert.calledOnce(get)
		sinon.assert.calledOnceWithExactly(
			warn,
			"Configured OpenAI-compatible provider does not support model discovery at /models.",
		)
		sinon.assert.notCalled(error)
	})

	it("includes openAiHeaders and caches discovered models in StateManager", async () => {
		const setModelsCache = sinon.stub()
		sinon.stub(StateManager, "isInitialized").returns(true)
		sinon.stub(StateManager, "get").returns({
			getApiConfiguration: () => ({ openAiApiKey: "fallback-key", openAiBaseUrl: "https://proxy.example/v1" }),
			getGlobalSettingsKey: (key: string) => (key === "openAiHeaders" ? { "X-Custom-Org": "repado" } : undefined),
			setModelsCache,
		} as any)
		const get = sinon.stub(axios, "get").resolves({ data: { data: [{ id: "custom-model-1" }] } })

		const models = await getOpenAiModels()

		models.should.deepEqual({
			"custom-model-1": { ...openAiModelInfoSaneDefaults },
		})
		sinon.assert.calledOnceWithExactly(
			get,
			"https://proxy.example/v1/models",
			sinon.match({
				headers: {
					"X-Custom-Org": "repado",
					Authorization: "Bearer fallback-key",
				},
				timeout: 5000,
			}),
		)
		sinon.assert.calledOnceWithExactly(setModelsCache, "openai", {
			"custom-model-1": { ...openAiModelInfoSaneDefaults },
		})
	})

	it("does not leak saved openAiHeaders or saved API key when onboarding a different explicit endpoint", async () => {
		const setModelsCache = sinon.stub()
		sinon.stub(StateManager, "isInitialized").returns(true)
		sinon.stub(StateManager, "get").returns({
			getApiConfiguration: () => ({
				openAiApiKey: "secret-a",
				openAiCompatibleCustomApiKey: "custom-secret-a",
				openAiBaseUrl: "https://endpoint-a.example/v1",
			}),
			getGlobalSettingsKey: (key: string) =>
				key === "openAiHeaders" ? { "X-Api-Key": "secret-header-a", Authorization: "Bearer header-a" } : undefined,
			setModelsCache,
		} as unknown as StateManager)
		const get = sinon.stub(axios, "get").resolves({ data: { data: [{ id: "endpoint-b-model" }] } })

		const modelsWithKey = await getOpenAiModels({
			baseUrl: "https://endpoint-b.example/v1",
			apiKey: "secret-b",
		})
		modelsWithKey.should.deepEqual({
			"endpoint-b-model": { ...openAiModelInfoSaneDefaults },
		})
		sinon.assert.calledOnceWithExactly(
			get,
			"https://endpoint-b.example/v1/models",
			sinon.match({
				headers: { Authorization: "Bearer secret-b" },
				timeout: 5000,
			}),
		)
		const firstCallHeaders = get.firstCall.args[1]?.headers as Record<string, string>
		firstCallHeaders.should.not.have.property("X-Api-Key")

		get.resetHistory()
		const modelsWithoutKey = await getOpenAiModels({
			baseUrl: "https://endpoint-b.example/v1",
		})
		modelsWithoutKey.should.deepEqual({
			"endpoint-b-model": { ...openAiModelInfoSaneDefaults },
		})
		sinon.assert.calledOnce(get)
		;(get.firstCall.args[1]?.headers === undefined).should.be.true()
		sinon.assert.notCalled(setModelsCache)
	})

	it("preserves explicit empty apiKey and does not inherit saved credentials or sensitive custom headers", async () => {
		const setModelsCache = sinon.stub()
		sinon.stub(StateManager, "isInitialized").returns(true)
		sinon.stub(StateManager, "get").returns({
			getApiConfiguration: () => ({
				openAiApiKey: "secret-a",
				openAiBaseUrl: "https://endpoint-a.example/v1",
			}),
			getGlobalSettingsKey: (key: string) => (key === "openAiHeaders" ? { "X-Api-Key": "secret-header-a" } : undefined),
			setModelsCache,
		} as unknown as StateManager)
		const get = sinon.stub(axios, "get").resolves({ data: { data: [{ id: "local-model" }] } })

		const models = await getOpenAiModels({
			baseUrl: "https://endpoint-a.example/v1",
			apiKey: "",
		})

		models.should.deepEqual({
			"local-model": { ...openAiModelInfoSaneDefaults },
		})
		sinon.assert.calledOnce(get)
		;(get.firstCall.args[1]?.headers === undefined).should.be.true()
		sinon.assert.notCalled(setModelsCache)
	})

	it("preserves explicit empty baseUrl and does not inherit saved baseUrl or make network requests", async () => {
		sinon.stub(StateManager, "isInitialized").returns(true)
		sinon.stub(StateManager, "get").returns({
			getApiConfiguration: () => ({
				openAiApiKey: "secret-a",
				openAiBaseUrl: "https://endpoint-a.example/v1",
			}),
			getGlobalSettingsKey: (key: string) => (key === "openAiHeaders" ? { "X-Api-Key": "secret-header-a" } : undefined),
			setModelsCache: sinon.stub(),
		} as unknown as StateManager)
		const get = sinon.stub(axios, "get")

		;(await getOpenAiModels({ baseUrl: "", apiKey: "secret-b" })).should.deepEqual({})
		;(await getOpenAiModels({ baseUrl: "   ", apiKey: "" })).should.deepEqual({})
		;(await getOpenAiModels({ apiKey: "secret-b" })).should.deepEqual({})
		;(await getOpenAiModels({ apiKey: "" })).should.deepEqual({})
		sinon.assert.notCalled(get)
	})

	it("warns without logging an error when authentication fails with HTTP 401", async () => {
		const warn = sinon.stub(Logger, "warn")
		const error = sinon.stub(Logger, "error")
		const authError = { isAxiosError: true, response: { status: HttpStatusCode.Unauthorized } }
		sinon.stub(axios, "get").rejects(authError)

		classifyOpenAiModelsError(authError).should.deepEqual({
			message: "OpenAI-compatible /models endpoint rejected authentication (HTTP 401).",
			isExpectedWarning: true,
		})
		const result = await refreshOpenAiModels(
			undefined,
			OpenAiModelsRequest.create({ baseUrl: "https://provider.example/v1" }),
		)

		result.values.should.deepEqual([])
		sinon.assert.calledOnceWithExactly(
			warn,
			"OpenAI-compatible /models endpoint rejected authentication (HTTP 401).",
		)
		sinon.assert.notCalled(error)
	})

	it("warns without logging an error when authentication fails with HTTP 403", async () => {
		const warn = sinon.stub(Logger, "warn")
		const error = sinon.stub(Logger, "error")
		sinon.stub(axios, "get").rejects({ isAxiosError: true, response: { status: HttpStatusCode.Forbidden } })

		const result = await refreshOpenAiModels(
			undefined,
			OpenAiModelsRequest.create({ baseUrl: "https://provider.example/v1" }),
		)

		result.values.should.deepEqual([])
		sinon.assert.calledOnceWithExactly(
			warn,
			"OpenAI-compatible /models endpoint rejected authentication (HTTP 403).",
		)
		sinon.assert.notCalled(error)
	})

	it("logs network timeouts and HTTP 400 responses as errors and returns empty fallback", async () => {
		const warn = sinon.stub(Logger, "warn")
		const error = sinon.stub(Logger, "error")
		const requestError = { isAxiosError: true, code: "ECONNABORTED", response: { status: HttpStatusCode.BadRequest } }
		sinon.stub(axios, "get").rejects(requestError)

		const result = await refreshOpenAiModels(
			undefined,
			OpenAiModelsRequest.create({ baseUrl: "https://provider.example/v1" }),
		)

		result.values.should.deepEqual([])
		sinon.assert.notCalled(warn)
		sinon.assert.calledOnceWithExactly(error, "Error fetching OpenAI models:", requestError)
	})
})
