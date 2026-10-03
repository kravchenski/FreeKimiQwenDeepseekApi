# Changelog

## [2.4.1](https://github.com/kravchenski/switchyard/compare/v2.4.0...v2.4.1) (2026-10-03)


### Bug Fixes

* **web-chat:** reject models the site does not offer instead of a silent fallback ([68eef57](https://github.com/kravchenski/switchyard/commit/68eef57cdef4a3b1dfb39b3ad7b452f8adc51532))
* **web-chat:** reject models the site does not offer instead of a silent fallback ([937b766](https://github.com/kravchenski/switchyard/commit/937b7663eea29a3b1fbc30d27208d9de13f23ec3))


### Documentation

* **readme:** add a terminal demo and desktop app screenshots ([a87b916](https://github.com/kravchenski/switchyard/commit/a87b916ae957e8e2cc4b9537f0c9d9c1c991238f))
* **readme:** present the project as Switchyard with a demo and screenshots ([144b464](https://github.com/kravchenski/switchyard/commit/144b464f7d460f62fec9e4ae8a46d5c9a026084a))
* **readme:** present the project as Switchyard with its current features ([1a551a7](https://github.com/kravchenski/switchyard/commit/1a551a7c5460c771ab1716e267814dea04108aaf))

## [2.4.0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v2.3.1...v2.4.0) (2026-10-03)


### Features

* **deepseek:** send images to DeepSeek through its file upload ([3a679a0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/3a679a014218c0ef04fe0fce244a88702bbc9e17))
* **deepseek:** send images to DeepSeek through its file upload ([d94df02](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/d94df02806facae680b8b103afc55ea91767b698))
* **keys:** take several keys per provider from .env and saved keys and rotate on limits ([2a3c8ca](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/2a3c8cac9a62b37725b16503172014ae62b1e267))

## [2.3.1](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v2.3.0...v2.3.1) (2026-10-03)


### Tests

* **router:** widen the timing margins in the race decision test ([4a2b4bb](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/4a2b4bbaf7ab41e381a3af2d089ba0bbd2e04d64))
* **router:** widen the timing margins in the race decision test ([1dde494](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/1dde494fa6b183b8d09dcdadc21dfba2cae80639))

## [2.3.0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v2.2.0...v2.3.0) (2026-10-01)


### Features

* **browser:** keep one page per chat conversation ([94e1cbb](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/94e1cbba81cce4809fa232fbf94d231d0543a291))
* **browser:** mask automation fingerprints on chat pages ([a5e0657](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/a5e065746f604408acadd786cffbb0a9377d897f))
* **browser:** reuse chat pages, auto-solve captchas and add image support ([12d60e0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/12d60e0a8fb436502fd12ced3df0d154e69df0a5))
* **captcha:** auto-solve captchas while opening a chat page ([4f49f8b](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/4f49f8bc246bc2ebbe1225d388cb9fe9095fbd60))
* **captcha:** decode challenge images into raw pixels ([9297d10](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/9297d10bc2790cb3bd45ea6bae0947fcb4d35a20))
* **captcha:** drag the pointer along a human-like trajectory ([1818ee9](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/1818ee9840c613ab5cca24e532afd615b47044b4))
* **captcha:** locate the slider gap in a challenge image ([e67794c](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/e67794cee343745b3be13d64957d8d810a65331e))
* **captcha:** solve the hCaptcha checkbox and the slider puzzle ([a61c0c0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/a61c0c0f3e433df8976714b5f6573ffbf932a253))
* **prompt:** collect image urls and mark image parts in prompts ([fb07806](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/fb0780667a9c1da41fbaad2b0fd44e9b430b5e6f))
* **unified:** give browser chats the configured first chunk timeout ([8f79e59](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/8f79e595060364abd2590074bdff13fa1991ece3))
* **vision:** send image parts to vision-capable web chats ([544ad94](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/544ad94f2ba792dbfb650ba8b9df2b07a379080e))
* **vision:** turn image urls into files for upload ([ab0279b](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ab0279bb22097a53ccd3a655e1427667441fd22a))
* **vision:** upload images through each site's own attach flow ([ed1277f](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ed1277fecfeb048aec39234e7c31554507c6e0ff))


### Bug Fixes

* **deps:** bump hono to 4.13.7 to patch the JSX XSS advisory ([0112946](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/0112946256a74271e885150f96dee193d61e5f6b))
* **router:** retry a direct route once on a transient unavailable error ([46886b1](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/46886b10b491511c83ff7d5c252b48778254d7bf))


### Tests

* **captcha:** run the solvers against a real browser ([3677f06](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/3677f06891792cf29da6ffeb2ba4412e4df5128f))

## [2.2.0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v2.1.0...v2.2.0) (2026-09-30)


### Features

* **agents:** keep only the tools a coding agent request needs ([862383b](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/862383b340693679cbb889e59b4d711d89251e4f))
* **agents:** keep only the tools a coding agent request needs ([affcc78](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/affcc78dca91e5866fab537a3e8599bcc402e4bd))
* **agents:** pass tools natively to API providers ([8d9f0aa](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/8d9f0aaae7f1107b2d8e2385b90535e0e07ee696))
* **agents:** pass tools natively to API providers and route agent requests to them ([4f554f7](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/4f554f7b4ffb00fd966a783c8a6863409511aacb))
* **agents:** run coding agents' shell commands through rtk ([9f14514](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/9f145142b87a40306c3062a1a826ec0417e67b6e))
* **agents:** trim tool output in coding agent requests ([b699f66](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/b699f66841a566073ad827a982b09d6387857497))
* **agents:** trim tool output in coding agent requests ([a41574e](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/a41574ea4ab2868456e54c3f33cb12c435fc44cb))
* **router:** send agent requests on auto to strong models with native tool calling first ([97cd5f6](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/97cd5f66a509569c6275d9a24b008a99f4297b53))


### Bug Fixes

* **agents:** follow rtk rewrite exit codes and scrub RTK_REWRITE_HOST ([1d71378](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/1d71378f57b58ed66fdf239b2fb6eedbf504f790))
* **agents:** keep rtk out of the history the model sees and collapse similar output lines ([b2f7c69](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/b2f7c691022aef3dd0b668e05129059685aedc0f))
* **agents:** keep the model's answer after a tool result instead of forcing ls ([fff8cee](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/fff8cee0b7854a274e2820e4d99057b1637fb3c3))
* **agents:** nudge replies that end by announcing the next action ([b643ec5](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/b643ec5dc905ca121b628c5e9fdbb3d81c672ee4))
* **agents:** read DeepSeek DSML and broken JSON tool calls and nudge replies that only announce an action ([9d78884](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/9d78884d3f0fcfb47fb4e455c6d7dcaa4be61a21))
* **agents:** retry an empty agent reply with a nudge ([9df2bf9](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/9df2bf9537b45adb335c0f0f96bcbfae1d81ff15))
* **kimi:** report errors that arrive after the done event ([bbffe20](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/bbffe20a6cd043054e4df131a2d08d9b3f56e56d))


### Tests

* **agents:** check rtk exit codes without running a shell script ([3a77fb2](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/3a77fb2f735abc18f15e6331c1dd76903a0801f7))

## [2.1.0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v2.0.1...v2.1.0) (2026-09-30)


### Features

* **arena:** add the arena.ai web chat as arena-chat ([ad4409a](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ad4409a85f581c5358e7d893c77f60d963921ead))
* **cloudflare:** add Cloudflare Workers AI with an Account ID field ([437e005](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/437e00538979f39fbab63b6edf49ae47b1765500))
* **decisions:** log how long each routing decision took and why it failed ([9c92ccd](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/9c92ccd4c7970024f044879c87c72cfae6d5a6d3))
* **decisions:** serve a Jev-style decision API and a decide mode for auto ([b5d4883](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/b5d48837eb53767866c79ecfc41edd6b555f36a6))
* **images:** generate images through Qwen Chat, Cloudflare Workers AI and Pollinations ([d8571dd](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/d8571dda2c160d659f73b3cba3d6c863c193f82f))
* **images:** generate images through Qwen Chat, Cloudflare Workers AI and Pollinations ([e833be0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/e833be04982b50f6e2c8870c3ac5ae53b62f2e32))
* **models:** show only the models a provider key can use ([dfdd3b0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/dfdd3b036ff4a177584b0bb187b491816dfe4013))
* **models:** show only the models a provider key can use ([38499bc](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/38499bc5153187b1530ae20ee8fae3b1d60b946c))
* **providers:** add GitHub Models, Hugging Face, Zhipu BigModel, Cohere, Aion Labs, OVHcloud and LLM7 ([ba16ace](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ba16ace5cbd8a5e3fc0f9011553e9459366d7cdd))
* **providers:** add xKiro with its free models only, off in auto by default ([2f944f6](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/2f944f6badc997b7421af76757af5dc87fcede48))
* **providers:** add Z.AI, Ollama Cloud, OpenCode Zen and Kilo Gateway ([5612c51](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/5612c51ecff70da35f5095a8269d9e20f9cbf3fa))
* **router:** expose routing decisions at /v1/decisions ([401e531](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/401e5311c5d75a352f64225bf974f5a2b778ba73))
* **router:** record every routing decision ([94ff56b](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/94ff56b145098267af15add1413e29ebfcd50926))
* **web-chat:** list and pick the models each web chat offers ([aa845f4](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/aa845f45bbfc6efe3e130577b41162d781b70267))


### Bug Fixes

* **gateway:** list providers in the startup banner from the catalog ([acb504e](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/acb504e8f37270e9ec0a57d0892b81dd71e32ddd))

## [2.0.1](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v2.0.0...v2.0.1) (2026-09-30)


### Bug Fixes

* **browser:** relaunch a closed chat browser and send Qwen prompts reliably ([65cb38d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/65cb38dd53b2ff7ea54efcb89716d6f7f9bc63c6))
* **models:** reload provider models as soon as an API key is added or removed ([e635bf5](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/e635bf55335989bbd2cd68af4e05132c5a1396fe))

## [2.0.0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v1.10.0...v2.0.0) (2026-09-28)


### ⚠ BREAKING CHANGES

* **qwen:** qwen* models, QWEN_TOKEN, QWEN_API_BASE_URL, bun run account add qwen and /v1/images/* are removed.

### Features

* **accounts:** sign web chats in with several browser accounts and rotate between them ([deba4d5](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/deba4d5e382af5f87ae0549365c99e5cc7ec73c1))
* **desktop:** add a settings page with theme, auto focus and race mode, and reorder the menu ([6dbdf42](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/6dbdf42b7a395008ed4a37dbcb1aa185f61f4c87))
* **desktop:** add a settings page with theme, auto focus and race mode, and reorder the menu ([e799ce6](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/e799ce6440cf198e22905985bf1b5f4c773dd0bc))
* **desktop:** add Get API key buttons that open the provider's key page ([7036c00](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/7036c003ee030a726784ac3f0b345127e22ce2d2))
* **desktop:** drop the hover tooltip from sidebar providers ([3047120](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/3047120417a490cd84217e29b1633b26c3ed97fb))
* **desktop:** manage browser accounts and connect them to every web chat ([61161aa](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/61161aac23ba835f647e2235abddbafec8969a91))
* **desktop:** move API keys to their own page ([6895652](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/6895652ff5cf2b16686a62e03beb0987b28a9d2f))
* **desktop:** open a settings page for each provider with connection, auto routing and models ([69d747f](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/69d747f4478bfe39b1b81d67d15ee5402f2ee25e))
* **desktop:** remove the providers overview page in favour of the sidebar list ([02b9ebb](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/02b9ebbca6656fc0957e3d2753f7c525001a29d1))
* **desktop:** show saved accounts on the Accounts page and only keys on the API keys page ([1b5da45](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/1b5da451672911c10221b924beb177aa7bbf99ae))
* **desktop:** simplify the providers table to provider, type and status ([9ab721d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/9ab721de9ab352e11f82f7b12c9c80efeecc552d))
* **providers:** add OpenRouter, Groq, Gemini, Cerebras, Mistral and SambaNova free API providers ([ff61f03](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ff61f03ac428d568122bab84d1ab977b65155bea))
* **providers:** add OpenRouter, Groq, Gemini, Cerebras, Mistral and SambaNova free API providers ([841b135](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/841b135929f8220b40a016685aaed9591e231567))
* **qwen:** serve qwen-chat through the signed-in Qwen web chat and wait out site challenges ([6e78399](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/6e78399e2643b9d4faa3085e6c02b88de6c9cbc9))
* **qwen:** serve qwen-chat through the signed-in Qwen web chat and wait out site challenges ([ce82213](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ce82213ff05245d03d840ab2fd76519388d56a89))
* **router:** tune model=auto for a task focus and race routes in parallel ([25170fd](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/25170fd45517be525c1867dfe87cb78b74368c11))
* **router:** tune model=auto for a task focus and race routes in parallel ([67a4b20](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/67a4b20da398bbcc70d0ad270f78bf1893b99f52))


### Bug Fixes

* **desktop:** keep both account cards inside the window and drop Qwen from the Google hint ([a6ddfdb](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/a6ddfdb81445206e847dbdf410551d5557a7bc51))
* **providers:** fail on error events inside OpenAI-compatible streams instead of returning an empty answer ([9a7a90a](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/9a7a90a0c4c8667664953ea5f50b4ab65395fd1a))
* **providers:** fail on error events inside OpenAI-compatible streams instead of returning an empty answer ([ae9e49f](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ae9e49ffc0c34e5266013b215677dedb691faa1c))


### Chores

* **qwen:** remove the Qwen API proxy provider, its accounts and the image endpoints ([d2c0740](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/d2c0740ad268e6510e80dd72573be631b3d378bd))
* **qwen:** remove the Qwen API proxy provider, its accounts and the image endpoints ([9903cde](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/9903cdeec91b5c332b5bd1c3f4d81cf0aa821fb0))

## [1.10.0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v1.9.0...v1.10.0) (2026-09-28)


### Features

* **accounts:** detect web chat sign-in and skip signed-out chats ([a250cc3](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/a250cc38fdf813ef8795780b9f7e2e71203df167))
* **accounts:** detect web chat sign-in and skip signed-out chats ([ef4a886](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ef4a8861ad3aac3356b66fb108ddc957fbf10474))
* **accounts:** keep ACCOUNTS_SECRET in the system keyring instead of .env ([8f93861](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/8f93861d4e6c1884edb12a427aaef55023403191))
* **accounts:** keep ACCOUNTS_SECRET in the system keyring instead of .env ([95d335d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/95d335d76ebc31c1958df8d10921b4faf25f67e3))
* **accounts:** keep all provider credentials in one encrypted registry and save NVIDIA keys there ([05465ce](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/05465ce5edc1527c55b1bfeb0da483c79495a85b))
* **accounts:** keep all provider credentials in one encrypted registry and save NVIDIA keys there ([b7150eb](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/b7150eb7382ad4a43e7c8c8c88f9e4232dc46d1c))
* **cli:** show every provider and how to connect it in bun run account ([59a6651](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/59a66516b8e40b971a4ffa1b6beae97f1af7066c))
* **cli:** show every provider and how to connect it in bun run account ([fe7aa83](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/fe7aa83b9fd07146ff5900aaf33bc3fc526cd26b))
* **desktop:** filter requests, adapt to narrow windows and manage Google accounts and API keys ([ec78dfd](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ec78dfd7f07044832146ac903332062d9da26ea9))
* **desktop:** redesign the app with a sidebar, provider logos and live provider status ([e357f56](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/e357f562bca258ba91f1a41476c99535712ab508))
* **desktop:** run and stop the API from the app, including a gateway started elsewhere ([744a38c](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/744a38cab12f2ac326d9dd6c1403f8ba98908027))
* **desktop:** run and stop the API from the app, including a gateway started elsewhere ([22d269b](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/22d269bfe087a80712debc1bb5c1aa697bdbad89))


### Bug Fixes

* **deepseek:** embed the PoW wasm so compiled binaries can load it ([a463443](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/a463443864b25d7c21e7c1c5ed3072971d6b9668))


### CI

* **desktop:** release .deb, .dmg and .exe installers with a bundled gateway ([b8f1c44](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/b8f1c448ce98a3720203f721ac09e3b2d9b52ff1))
* **desktop:** release .deb, .dmg and .exe installers with a bundled gateway ([5863964](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/5863964f349c48d0673d4d9d1d5536585c769bff))


### Chores

* **deps:** update Bun to 1.4.2 and read the version from package.json in CI ([dc1b5ec](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/dc1b5ecac439e9a10962016a217c4a1464604c56))
* **deps:** update Bun to 1.4.2 and read the version from package.json in CI ([26da854](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/26da8545203ca24ec2b08c19f7e55451e74429cd))

## [1.9.0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v1.8.2...v1.9.0) (2026-09-27)


### Features

* **cli:** add a model probe that lists which models answer ([94aac13](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/94aac1311b85a183869e1b0ef2d5ee653f1d441d))
* **cli:** add a model probe that lists which models answer ([0a130ea](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/0a130ea3c0de066eb76c4954cc81312259a2d789))
* **models:** discover every upstream NVIDIA model and hide models missing for the account ([b81cd40](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/b81cd40a92b881ab3ada92d740848b86b97335d0))
* **models:** discover every upstream NVIDIA model and hide models that are missing for the account ([06803b6](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/06803b67231dd4d6682b45bca298b30eaf1f679c))
* **router:** build the auto chain from discovered models and skip routes that do not answer ([682198d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/682198da55985f4cb78ac04fb64573d4e7ededce))
* **router:** build the auto chain from discovered models and skip routes that do not answer ([38eab0b](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/38eab0b0aca6cdeee4b5956bdb007d677199e55c))
* **router:** order the auto chain by measured response time instead of fixed preferences ([b16506f](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/b16506f03a6d8fe0fa6093f5ae853ee84b06059d))
* **router:** order the auto chain by measured response time instead of fixed preferences ([d8a43d6](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/d8a43d66b46201f952699a8970da7f2689800940))
* **router:** prefer the newest models of each NVIDIA family in the auto chain ([67b1628](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/67b162880afd3ae9a439d16acb7dd43b96fec533))

## [1.8.2](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v1.8.1...v1.8.2) (2026-09-27)


### Bug Fixes

* **accounts:** keep the user info path narrowed for strict type checking ([376b74a](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/376b74a1892952484270ce5c21c5fc35e0c745d8))
* **accounts:** survive site redirects while capturing a browser session ([648a32b](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/648a32b2e01a6a79ade1f2f5061182b45679b09f))
* **accounts:** survive site redirects while capturing a browser session ([3affc75](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/3affc75b4c75b68ff12223b0bb01c5ddbfad2e07))

## [1.8.1](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v1.8.0...v1.8.1) (2026-09-27)


### Documentation

* **examples:** translate examples and guides to English and point them at the unified API ([fd46449](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/fd4644910c7dec52c233154ab97c26adbf965541))
* **examples:** translate examples and guides to English and point them at the unified API ([aa116fe](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/aa116fe2ff2310da7aadc53b119f0c41039f073e))


### Chores

* **i18n:** translate user-facing messages in code and scripts to English ([d0598d2](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/d0598d2d9c9e94f87d2b9e619aaac7da5cb34e1b))

## [1.8.0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v1.7.0...v1.8.0) (2026-09-27)


### Features

* **observability:** add request ids and Prometheus metrics ([4f83108](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/4f8310846a78c593f4cfffce11c4158957939f1f))
* **observability:** add request ids and Prometheus metrics ([257d2a0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/257d2a00ac977a032b53115232e32f577825eeda))

## [1.7.0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v1.6.0...v1.7.0) (2026-09-27)


### Features

* **desktop:** sign in to Kimi, Z.ai and Qwen web chats from the app ([f9bf4c9](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/f9bf4c98f0d46c369a95ab7bbd43b7e7456b7a30))
* **desktop:** sign in to Kimi, Z.ai and Qwen web chats from the app ([a7731bf](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/a7731bf634dcdb8c19ed730091f55d764ed3942d))
* **images:** add image generation and edits through the Qwen API ([03e36ff](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/03e36ffa63daee8a052ceded6fbeb6a63d96b12f))

## [1.6.0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v1.5.0...v1.6.0) (2026-09-27)


### Features

* **router:** keep agent sessions on the provider that served them ([dec194a](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/dec194a9eb7445be5e13beb3985b756f295e99a6))
* **router:** keep agent sessions on the provider that served them ([6cf447a](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/6cf447acf74b5cf320fbcec0df8daeeefa3d2bfc))

## [1.5.0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v1.4.0...v1.5.0) (2026-09-27)


### Features

* **responses:** stream the Responses API token by token with reasoning summaries ([c9e9462](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/c9e946281a0b94a541619b92c0cddffd5e463e4c))

## [1.4.0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v1.3.1...v1.4.0) (2026-09-27)


### Features

* **anthropic:** stream Messages token by token with thinking blocks ([e88b9a7](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/e88b9a7106bc235487512efd9aed7e9b01882388))
* **anthropic:** stream Messages token by token with thinking blocks ([950f9d5](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/950f9d55e9d740a457bfbd8494b497297e3243f1))


### Bug Fixes

* **status:** log chat requests once on completion, including mid-stream failures ([5610d2f](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/5610d2f4762ef044ae70b4d7cfd98b5239efba29))

## [1.3.1](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v1.3.0...v1.3.1) (2026-09-27)


### Documentation

* **models:** document current models and fix agent setup fallback list ([c89d335](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/c89d33511edb682de2d84f2e910f8473d21a153e))
* **models:** document current models and fix agent setup fallback list ([d5c3851](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/d5c3851d2bc8d5b73cd31a38ebec6ade5531d0d2))


### Chores

* **types:** add Bun types and run tsc in CI ([23f2625](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/23f2625870dba916beacd6de19e19e19ec40a852))
* **types:** add Bun types and run tsc in CI ([7d9c697](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/7d9c6977f36fb4bf092064dfd2d2017e6aaf6c82))
* **types:** enable strict TypeScript ([e8d4aad](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/e8d4aad3cee92f4c1913542e3d2c10e0f5d58c61))
* **types:** enable strict TypeScript ([1226e6c](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/1226e6cd359980475b650d312a85d00e84d4b56e))

## [1.3.0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v1.2.0...v1.3.0) (2026-09-27)


### Features

* **glm:** serve glm-chat through the signed-in Z.ai web chat ([7bd5f2a](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/7bd5f2a08f4ffbb01a2aa8a79e3999e2059dafd6))
* **kimi:** serve kimi-chat through the signed-in Kimi web chat ([9df8d75](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/9df8d7543def411079e68e38956a39f4f65ee97c))

## [1.2.0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v1.1.0...v1.2.0) (2026-09-27)


### Features

* **browser:** send chat prompts through the signed-in browser and stream replies ([970a002](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/970a0024e595c13a20169f51c7dbac4494b56e9b))
* **browser:** send chat prompts through the signed-in browser and stream replies ([bb6c9c6](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/bb6c9c69ac6ac7bb5336754ab6e373e402cf1522))
* **cli:** open sites in the browser profile for manual sign-in ([091fee2](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/091fee22dcd41f65c072ae04df780c2686230b89))
* **cli:** open sites in the browser profile for manual sign-in ([c54995e](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/c54995e2984384a727ea3c41cdc71ff0ed7f91c2))

## [1.1.0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/compare/v1.0.0...v1.1.0) (2026-09-26)


### Features

* **accounts:** add encrypted credential store ([868246d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/868246d67527c7564fc0732e5011638cf9c9dff9))
* **accounts:** add encrypted credential store ([4bc2ed6](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/4bc2ed6a63f963de56f4c2d9cb1b2c06e0894469))
* **accounts:** add persistent account pool with health scoring ([f70676c](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/f70676c44595c204f48f3363c80b5d93341d6280))
* **accounts:** add persistent account pool with health scoring ([c1586b1](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/c1586b1a9cff214a80cc9172d4e706475b36164e))
* **accounts:** capture Qwen sessions after a manual browser sign-in ([3bb7078](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/3bb70781205bfcb0e28db48f3aae1004a3c98a46))
* **accounts:** capture Qwen sessions after a manual browser sign-in ([e9ab529](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/e9ab529bc821ce374b8aca16c18870649671c803))
* add Qwen Chat media generation endpoints ([cc40a89](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/cc40a89b14d839eeb4970ea5f72174a5c7cc4b97))
* **agents:** add cross-platform integration installer ([cf52b90](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/cf52b9084ef8ab046f561efb101ea5e2360e7bff))
* **anthropic:** add Messages API endpoint for Claude Code ([de32b1b](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/de32b1b39a88997f92761a34fc02b8d921dce5a9))
* **anthropic:** add Messages API endpoint for Claude Code ([b270ff3](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/b270ff3c47382d632f7f2c34ddf5b21ac113b3af))
* **browser:** add persistent Google browser profile for account sign-in ([9e5aeab](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/9e5aeab0c306d4bce10af315524b870fd93044c0))
* **browser:** add persistent Google browser profile for account sign-in ([ded936f](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ded936ff02102a4e4bb9a11e65c75efcfab4a183))
* **cli:** add account command with hidden password prompt ([adc5ae7](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/adc5ae750a57734510d2ea6c4d6ec66c7a43464e))
* **cli:** add account command with hidden password prompt ([a4e298e](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/a4e298e196827b3e3dc11efa93524fb06b9df140))
* **config:** validate environment with zod schema at startup ([c196edc](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/c196edc2b3a2af0bdcceff1fe9124f24e358e4c4))
* **deepseek:** add browser account menu and session storage ([d76ae9a](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/d76ae9a305d234a672a3e94255ec8dc0439b3b99))
* **deepseek:** add web chat provider with pow support ([458b928](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/458b928704df4fe25056687837e3b1f27027fb72))
* **deepseek:** select accounts through the shared pool with failover ([c67dca3](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/c67dca306da07a97664f0e50d42b4ab99c80cc8b))
* **deepseek:** select accounts through the shared pool with failover ([903a4b4](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/903a4b415fe4fc820f625c6982197cb4e6e0d197))
* **desktop:** add and remove Qwen accounts from the app ([4331efd](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/4331efdf0eef433fd56db6c7cf3fae3c3dd7b5e2))
* **desktop:** add and remove Qwen accounts from the app ([0714880](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/07148800c63229801e876e319735448d8dbcd8a0))
* **desktop:** add GPUI desktop shell that starts and monitors the gateway ([fb10755](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/fb10755787339373d0f775fa30004d3a43e5ef4e))
* **desktop:** show providers, accounts and recent requests ([c9ba96b](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/c9ba96ba859520d7f7df6931b8bfed229b0e7d1d))
* **desktop:** show providers, accounts and recent requests ([f563a0d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/f563a0dec0db04bff2d94264f6d83883852512a8))
* enhance tool call JSON handling with new repair functions and tests ([b84c7bf](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/b84c7bfda355ff3cafc935965fe1ccbba36e249e))
* **errors:** classify provider failures and return matching HTTP statuses ([53ba792](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/53ba79286d821ed1b30bdb0fa86baf53a74b88d5))
* **errors:** classify provider failures and return matching HTTP statuses ([4d19788](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/4d19788b40f1f5156d920581f3750a6402c2c199))
* **glm:** add glm-5.2-free model and update GLM list ([e54a828](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/e54a828b055bf586dc6c67af07e0b6acfbf4d254))
* harden API request handling ([50a38ed](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/50a38edcdbca5a53e9b5e0b04dd18f55f0df95fc))
* **kimi:** add web provider and unified routing ([45a6a7b](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/45a6a7b0bb72dec54821d5f2a24145c6cd3c99c7))
* migrate runtime to Bun and add release automation ([f2f5777](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/f2f5777deb1045f7d6effc7bf9721d7577bced2c))
* **nvidia:** add Kimi K2.6 and MiniMax M2.7 via NVIDIA API ([6f6af3e](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/6f6af3e0b0abae05e88bc276621ab85b440d97ea))
* **nvidia:** add NVIDIA API provider ([fca3b5a](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/fca3b5a86a3c43a8dd7e0db1db8ca1e0d3343885))
* **pi-agent:** expose all Qwen and DeepSeek models ([bb1165c](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/bb1165cef0084a0e762c0d4f3331c31ddb4d2dae))
* **pi-agent:** preserve sessions and migrate runtime to TypeScript ([6e06b6e](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/6e06b6e7f8ca4bf2f4e3fb85cf10a0758dea9659))
* **pi-agent:** unify Qwen and DeepSeek provider ([a32febf](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/a32febf84173eba6c2418e1f67859ee60de68ccd))
* **platform:** add portable launcher and browser discovery ([d01a5ce](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/d01a5ce6885b9d28bbe621fe87780f1cccb6d184))
* **providers:** add GLM, Qwen, Sapiens and StepFun provider clients ([6e36bbf](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/6e36bbf69a465a2c186b512d0a7320a69942d589))
* **qwen:** route qwen models through the Qwen API proxy ([34f5999](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/34f5999320d5c365848fe888fc59d3232fdae1be))
* **qwen:** sign in through Chrome over CDP with Playwright ([dfce7e8](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/dfce7e8586d2d12997f4d562c27ecb666ffb3f16))
* **qwen:** sign in through Chrome over CDP with Playwright ([1809882](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/18098824312b2daf4a434b73eff98afbb4fcd4d9))
* **qwen:** sign in with stored email and password and rotate accounts ([afde11b](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/afde11be7a8c99d31248f0c1ba120bca9453917b))
* **qwen:** sign in with stored email and password and rotate accounts ([2a38e6b](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/2a38e6bfb8f0d850558bf4b875ce7ed4d87c09e7))
* **qwen:** track account health in the shared pool from upstream responses ([53c729e](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/53c729ed3b41719e94b033c4a5a13ea9579c5248))
* **qwen:** track account health in the shared pool from upstream responses ([8bb158d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/8bb158d3e486676db2639ded27e5e6cf74a20942))
* **responses:** implement Responses API gateway with tool flattening and message conversion ([f75576d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/f75576d4acfe56b8b8a72ecc63ed0bc221d6e1ae))
* **responses:** serve the Responses API from the unified server with typed SSE events ([b48f37b](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/b48f37b8c5fdc2e09cfde902f9a9664fc1152f20))
* **responses:** serve the Responses API from the unified server with typed SSE events ([fa7bff5](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/fa7bff571138f938f03b2604aa90228d2cfc6c84))
* **router:** add auto model routing with fallback before first chunk ([c8cc707](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/c8cc70757dbad8da02fa2bbf8cd438037b589419))
* **router:** add auto model routing with fallback before first chunk ([a12d61d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/a12d61de34327701e69be366b2698d16f898fcc3))
* **status:** log requests and expose gateway status endpoint ([58ed77f](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/58ed77f336566464802a7b74c53cd114d8bea508))
* **status:** log requests and expose gateway status endpoint ([6f44975](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/6f4497545043605baa8bc3d458bad78ef8e36f72))
* **store:** add SQLite gateway database with migrations ([f41494f](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/f41494f42dfa48434a243bebd9a9b462974f2f3b))
* **store:** add SQLite gateway database with migrations ([df5649d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/df5649df1a76810907d2802df8e9d11636f2753f))
* update Qwen models and add agent demo tooling ([8d31a96](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/8d31a96a7edaacc8801580929d21147a75b48917))
* Добавлена поддержка Qwen 3.5, генерация изображений и улучшена работа с OpenWebUI ([4d83ef9](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/4d83ef915e3f37943f7fc367f3d16e11224ab745))


### Bug Fixes

* 401 handling ([4dc27b5](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/4dc27b561d807cad696607a0c9cba8c5d13cfa50))
* 401 no auth, and new session ([1a2f235](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/1a2f235b74728cd9472c26c149cefe0e310d4ab1))
* Add onChunk callback support to sendMessage for JSON responses ([d88b5bf](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/d88b5bf98f27095602d36783c1becff702920470))
* **browser:** wait for Chrome exit before removing the temp profile ([5941ca3](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/5941ca3903d0fe0a40767894335ec68de9ef3b3b))
* **ci:** keep optional chromium-bidi external in the build check ([9fe433c](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/9fe433c0075e298470c9e6d5d9095c628304ecf5))
* **codex:** add metadata and per-model profiles ([9b42078](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/9b42078e1ea0fd3da1fb037d3c1b24b5505d8efb))
* **codex:** migrate profiles and bridge responses ([45cf296](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/45cf296df89e350aa9f53f378add5eb37bbe8d33))
* **deepseek:** make Pi Agent streaming compatible ([e9cb7e2](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/e9cb7e279f1245196cab45a98efae070e62c73ce))
* **deepseek:** preserve initial streamed response fragment ([78b097a](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/78b097aa5db8c6a3a97c50521d7a1ba8494cc176))
* **deepseek:** read text delivered in response fragments ([d302cbe](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/d302cbe643d522c9da175368764ed52a6dba836c))
* **deepseek:** read text delivered in response fragments ([b7861f2](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/b7861f284ae57f2d25102c581ebab6b965de0e5e))
* **deepseek:** retry empty conversational tool responses ([34c46db](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/34c46dbeaecc173379246f3f98933050eadfb470))
* **deepseek:** support browser registration and token capture ([3530eab](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/3530eab09a422b8bb9f0b55ff2c06e93cea7bd7f))
* **deepseek:** use persistent system browser for google login ([8bb45ae](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/8bb45aeca934a946385ceb58c0bf0c9bdcc83f9a))
* **deepseek:** validate auth page host instead of url substring ([3bbb415](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/3bbb415df6eae64976c57d4095de7d5b20f6a1e8))
* **deps:** upgrade vulnerable transitive dependencies ([5b242eb](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/5b242eb16a10db6d4063afdb35caac77274c7823))
* **docker:** include session data and fix permissions ([56a40fc](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/56a40fce531771fd0d2853732e31d65d34dd77f0))
* **docker:** rewrite Dockerfile with proper multi-stage build ([4c3647e](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/4c3647e520fc8070ecd9fb31db93f4f3818cad1e))
* **docker:** run the unified API by default in compose ([23c1e48](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/23c1e482cc653a5295446171631819bc620ca78f))
* **docker:** run the unified API by default in compose ([5385645](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/5385645c569d96c28b659a7b9f9854cc7f0a47b6))
* **docker:** stop baking session credentials into image ([bfd6d10](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/bfd6d10820c70ef2d2621b6d900515d9bc938080))
* **docker:** strip setuid and setgid bits from runtime images ([648430e](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/648430ec23109a54b171ead61fabdff08dbfe934))
* Duplicating the last message ([42fd482](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/42fd48289f8a4453ba31db5fc8b938693835463e))
* Duplicating the last message ([feff34d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/feff34db87957247ff6416c8d6b70a323c15f1b7))
* fix SyntaxError and uploading images and etc. ([6cd141a](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/6cd141a7d54d154bac422857f8dabf05bb361911))
* **gateway:** compare bearer tokens directly in constant time without hashing ([a15362a](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/a15362a0555f7c256c5ea7324a490c3599fcf3c1))
* **gateway:** compare bearer tokens via keyed HMAC instead of plain hash ([23d8c41](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/23d8c41a56ed184b2484270c95786275830ddfb7))
* **ghcr:** publish latest images from main ([bd6bdd7](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/bd6bdd75a3768e78066581f32f800356b918dc69))
* **ghcr:** publish latest images from main ([4538a84](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/4538a843dbfdc441c0ee7e1e36fa60dc243bd383))
* Handle JSON completion responses from Qwen API (not just SSE) ([e7f774b](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/e7f774b538b0640b6d857cf2edcff080bc6475e7))
* isolate chat context between conversations by default ([4c0243c](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/4c0243c7803fa0e6afb1ceea0a2134615c23656f))
* isolate chat context between conversations by default ([b58e045](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/b58e04588cdb5d3e5ad6f5fe0f591499cd4de30d))
* **kimi:** remove auth script importing deleted account modules ([bd46332](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/bd46332548e174f7d3a7a01c1d28366af2f8c515))
* midels mapping thx sqdzy ([93f332e](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/93f332e93e757319fdcf61145badc495e4a5c5be))
* **nvidia:** fix provider detection and non-stream response handling ([a1732eb](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/a1732eb62d459870640f206da0abad0ee134b05a))
* **nvidia:** list models from NVIDIA and replace retired DeepSeek V4 Pro ([8692c9c](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/8692c9c08a26069b6f937dea41c32c8ded75b64f))
* **nvidia:** list models from NVIDIA and replace retired DeepSeek V4 Pro ([7b4077e](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/7b4077e6bc8c14c43424e51380b29016915217d1))
* **pi-agent:** convert simulated XML tools into real calls ([e340a45](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/e340a450cccf14fb729f1a99c452dbdc3a8a8b58))
* **pi-agent:** prevent conversational shell tool calls ([735453d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/735453d8dc59408326367a49f7d4b5c154bcf1f1))
* **pi-agent:** recover DeepSeek Chinese-style tool calls ([3ea207e](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/3ea207e4f97497b62b364655dc006cea2f14a82b))
* **pi-agent:** require workspace inspection for code tasks ([aff88e4](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/aff88e42cd52eab90d7abff54fe6a322540018a5))
* prevent chat history path traversal ([bfb9213](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/bfb921322a944dda4c8536c12a5acf82e8fb5591))
* **qwen:** keep account emails out of sign-in errors ([d2d5890](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/d2d5890259d000979bb2cc8b2ad382aafeddbca2))
* **qwen:** treat expired-token errors as auth failures and re-login ([b73e466](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/b73e4666860360544238de9493ea6b536ec8eacc))
* **qwen:** treat expired-token errors as auth failures and re-login ([fcb3304](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/fcb33041118d53e28082501664033f5686e30870))
* remove dead kimi accounts and fix test ([2070dca](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/2070dca0b77ae45ef02a49b394f7753ae1ae1670))
* security baseline for unified API, Docker and CI ([33d5a51](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/33d5a5129db5d93f6db953684aa7400db7858a1b))
* Send JSON response content via streaming callback when Qwen returns JSON instead of SSE ([ee498a3](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ee498a318aaefc0cd5b23be417816f57d57e0243))
* **sessions:** persist Pi conversations across providers ([0f9e24e](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/0f9e24e6558a7118f72f4bbb539d452f1fc1c8bb))
* stabilize Puppeteer page handling to prevent detached frame errors ([3fc21ea](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/3fc21eaeb1599f9688b13dd7978152428637bf19))
* stabilize Puppeteer page handling to prevent detached frame errors ([0b1093e](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/0b1093ed28e549c00a8b45eafa708b3de7d3fa85))
* stream chunks — JSON.stringify SSE; Unicode-safe chunking (Array.from); chunkSize=512 ([0acde95](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/0acde959f16d77d8251b3325039ab45ba4a81044))
* Stream json parsing ([c8d59c9](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/c8d59c9cbc518214b43c90f541d3878867ba371e))
* support Hermes tool calling loop ([711e3fb](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/711e3fbd22bf069cc72b63a578b0dc756577f717))
* Syntax error in chat.js (await in non-async function) + add missing MAX_FILE_SIZE import in routes.js ([af77673](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/af7767339fd0eb4309c6fd506436a1b9e28900a0))
* **tools:** recover prose-style tool calls ([79b5226](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/79b52261a9dab319df3fe8aa56f182f52c2ddbdb))
* **tools:** recover write content and fenced checks ([1f81f0d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/1f81f0dc10075da5704cc69bb24e3675b20311bb))
* **unified:** add optional bearer auth, body size limit and JSON validation ([25e46c3](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/25e46c36ad710c91251640431ef4158416cb4ac6))
* **unified:** emit SSE error instead of breaking stream on upstream failure ([e39dd7d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/e39dd7d8af8848bf326dd47aad21187f631d88d8))
* **unified:** keep tool prompt when retrying empty tool-call responses ([40cbc53](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/40cbc53e878880580334419bec2173bc0004d636))
* Системные промпты корректно работают ([8f868dc](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/8f868dc1d13d7cdae1e9df67958118338742af4e))
* удалены несуществующие модели qwen3.5-flash-2026-02-23 и qwen3.5-plus-2026-02-15 ([138100f](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/138100fadd7e7be9e0d1e9d0ccd0096b72419ba3))


### Refactoring

* **cleanup:** remove dead code and legacy examples ([386e9be](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/386e9bea1452af6faaa4076324e9bfb12642ad49))
* **core:** add provider interface, registry and SSE line reader ([514713d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/514713d97c8aa310a24bb432b257d2e30fe36bf6))
* **core:** add provider interface, registry and SSE line reader ([ea5bbce](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ea5bbce84be77ef9fb8279468a3d0b0890555040))
* **core:** isolate gateway routing and session storage ([3d1d7b1](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/3d1d7b1ae1a7f76931ece123f3ec4acb24f4f747))
* **deepseek:** add provider adapter over web client ([1075ffa](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/1075ffa98dc2e364c917c357f6dd80231b4afc4a))
* **deepseek:** add provider adapter over web client ([638e7f7](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/638e7f760b6891a1e892f259ddf8dcecfb947400))
* **providers:** add OpenAI-compatible provider for ZenMux and NVIDIA ([558a5b4](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/558a5b41d30718ab9b31118ff49e2ef782dadf9a))
* **providers:** add OpenAI-compatible provider for ZenMux and NVIDIA ([3f3710c](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/3f3710c59e34a361c9b09549b53a41e0fdb5e156))
* **providers:** remove superseded ZenMux and NVIDIA clients ([ccfbd40](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ccfbd403f65e15f8cb5966def318215f287832cd))
* **qwen:** drop browserless sign-in so passwords are never hashed locally ([2850707](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/2850707ce8a6f0c861fddbcf7304baa3bba8128e))
* **qwen:** sign in through Chrome over CDP instead of hashing passwords locally ([e326d13](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/e326d139be10a0043dd338171b35576a7a459841))
* replace Express with Hono framework ([47f7583](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/47f7583100e7480f95f954774f636748a30d2a3d))
* **runtime:** add readiness and service healthchecks ([978c38c](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/978c38c463758c066aef828641bf0c61f20ca3fc))
* streamline Dockerfile and improve multi-stage build; update dependencies and enhance README ([fbaa136](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/fbaa136cd69c14f7388ba274506b37703af01956))
* **tools:** move tool-call parsing and repair into core ([f54f266](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/f54f266b481eb9ef0b94394a55aceb688a9aea64))
* **tools:** move tool-call parsing and repair into core ([8df2e1e](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/8df2e1e91cdd54eb84db73c18bdb2669eab99171))
* **unified:** route chat completions through provider registry ([6fbcfe1](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/6fbcfe172f366d749620edb43acf20185aee52c1))
* **unified:** route chat completions through provider registry ([5c54e42](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/5c54e427644259b79b20daa355f303b0ea2553ae))
* update core server modules and API routes ([dcec453](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/dcec45303762f763d90bb9daa6929838237854fd))


### Documentation

* add architecture and security review agents ([2947fb8](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/2947fb8fb71a106ec48607225bd3f5c5cc98f105))
* add readme cn v ([0beb13d](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/0beb13d73fb6d18eac55b59482cdebb71ff8e503))
* **agents:** document unified agent setup ([9024056](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/90240560c57840c133de10dc2ecb198008d1a510))
* clean up README structure, remove duplicates and fix API examples ([9e0ca17](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/9e0ca174adca0238c377cf706980e621882e59e6))
* **deepseek:** add qwen-style startup flow ([4567327](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/4567327d116eccedecfb025b041b5c0379df9b22))
* document DeepSeek web proxy and Pi setup ([ff04004](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ff040046f66b0099f4354ff8d09ab0e454fcfd2e))
* document unified provider architecture ([2ab3c06](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/2ab3c069e8eed0ae62bf7eabfea0f6c85c99c9f6))
* **env:** shorten example comments ([021278f](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/021278fb101a91239bf1698d6e3f6ffc61551c85))
* improve project overview and navigation ([da828fc](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/da828fc89d3e77f66cc034476683d8ecb1caad4c))
* improve project overview and navigation ([4f829f5](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/4f829f50aa5a3ee0460215a5e17d7e5e887e33dd))
* improve README and add ForgetMeAI branding ([daae39f](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/daae39fde79386b8c0260582dfef5b3c2b10a1d9))
* **pi-agent:** add DeepSeek web provider setup ([75d6f05](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/75d6f051891562231a2a235851a948a9b1d3e322))
* postman ([589c3bd](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/589c3bdeeec1890020c097dfc8da96bc94d282a1))
* rebrand FreeKimiQwenDeepseekApi to FreeQwenApi ([67f3984](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/67f398414b045c76e07fcf6217a751914a6e7c3a))
* Refactored README.md ([2778b7b](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/2778b7b624ae5590c9377b6be3b17053d3cc051c))
* remove stale commands and provider names ([84be517](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/84be517917c375626d00f102d82d21ab99289fac))
* translate fork docs and messages to Russian ([7edfe61](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/7edfe612bb08ac354fd5285014f5748c6294e8df))
* Upd ([d535311](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/d5353119a07f9de3edbd01d16b3f293fff382b90))
* update README with final model list and clean structure ([ac9f7ef](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ac9f7efec16cc2649f9c8be2b4dc4f8fae80cb33))
* UploadFiles ([dd2d78f](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/dd2d78fda474fcc378492ff6bb34f41614f5354a))


### Tests

* **accounts:** skip POSIX permission check on Windows ([f00b765](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/f00b765f9ef5d8eea9c80100e0ee558011b413a4))
* **browser:** compare profile paths portably ([964a724](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/964a724bf38a454ac6143cced1932c427bfa984a))
* **gateway:** use ascii-friendly multibyte token fixture ([702cc31](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/702cc3189c06ea1f913fb1c91578225252e2d04e))
* **qwen:** run real-browser login tests only with RUN_BROWSER_TESTS=1 ([9e3b22c](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/9e3b22cbababf0e204a5ac6f813b3ac35e5b4cb0))
* update tests and add setup scripts ([fecf2a1](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/fecf2a114c9feb9c0f41b527a1cc3e6a2f48d62f))


### CI

* **desktop:** test the desktop app and attach binaries to releases ([411a96a](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/411a96a5175d0e17ef03ea3a206004244882a9aa))
* **desktop:** test the desktop app and attach binaries to releases ([65f7d39](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/65f7d39c8f5e5eef222b5b77a666bedec316e76d))
* **ghcr:** publish separate provider images ([0b07cc0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/0b07cc03f982df01c8d995b84ad6ae25ef347a71))
* ignore unfixable extract-zip advisories from puppeteer downloader ([010a3fa](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/010a3fa4eecf27979d03d3ded9a5a27d5ab6cf1c))
* **release:** publish GHCR images and configure Codex ([0b0d57f](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/0b0d57f6be3937f9ac3a4b6fe6558aaf993e98b4))
* version releases with release-please and update actions ([73b1ce3](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/73b1ce33aea74269832af16b27f7661adb412fcc))
* version releases with release-please and update actions ([826ac30](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/826ac308daedcd94e3cb0cc860f1e3347f0a706d))


### Chores

* **ci:** enforce dead-code analysis ([71f0dac](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/71f0dac0cddca57a14f3b0a08958087b272e62c1))
* cleanup models, configs and Docker ([ccb3f2f](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ccb3f2f82dddc65c13cfeedafd4a7daf9ed348e2))
* **cleanup:** remove dead code, unused files and scripts ([3cef342](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/3cef34271183d5f02c946dd2439a0a744a199fe2))
* **config:** keep only unified server settings in the config schema ([c927c3f](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/c927c3f2cd98fdb27be60806fd9accc3e40531ca))
* **config:** keep only unified server settings in the config schema ([d27c0dc](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/d27c0dc03b6288e2ed526dd2223414cc39ffc768))
* **deps:** remove unused dependencies and fix broken scripts ([508faa1](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/508faa1ced750ee0f91f2b99f5e6ffacb2c9c07c))
* **docs:** remove outdated image and video generation guide ([2e26fd2](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/2e26fd26063a6df946dc375829f2d0d0025ad86d))
* gitignore session/kimi ([440a731](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/440a7311dbedf9d6be557825461e6e4b637ae735))
* **providers:** remove ZenMux providers and the standalone Kimi service ([8c88ef6](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/8c88ef6cb95da04762424b4b072f519ec96c8ac9))
* **providers:** remove ZenMux providers and the standalone Kimi service ([dd81593](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/dd81593bdc333a66fbbe74b00653eb66e5c8af86))
* **qwen:** remove the legacy Puppeteer-based Qwen stack ([b919aba](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/b919aba2adfdd639436757365299dbd6a5d94dbe))
* **qwen:** remove the legacy Puppeteer-based Qwen stack ([e25ba98](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/e25ba9837f5e401b74da8b34680683fc3df7653b))
* remove dead code, update CI/CD ([3b62cfb](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/3b62cfb97bc5036222a28c6ad82e1c898a67d9f2))
* remove dead providers and sessions ([349960c](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/349960c2fda2f2fb3c663ecabb6650218538bda4))
* remove leftover kimi session dir ([dfa58c1](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/dfa58c1ec4a35d56b133e59cbe5863c59739abfc))
* remove non-working models from list ([c363398](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/c363398a87411e20fb22cdcb4dcfdfeb916a74b0))
* remove obsolete legacy files ([3e7653a](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/3e7653a8c5f706a8357464c9cb2cd3a1a75852ac))
* remove redundant code comments ([aa6d0eb](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/aa6d0ebc0843adfbfdeffd6d295ccf7ade6a6043))
* **repo:** add author and MIT license ([46f2e09](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/46f2e09b434a6cabc189967b12926f577b37d157))
* **repo:** establish cross-platform project standards ([ff4ebe0](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/ff4ebe040c624f308c7c47e6bbb8639ef03ec821))
* **repo:** migrate examples to TypeScript ([80e5a23](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/80e5a235181e98eec6150a244b469cb8da7b51b8))
* **repo:** use FreeKimiQwenDeepseekApi package paths ([da32989](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/da32989ba74521105672821c918b60ea91e44b99))
* update .env.example with NVIDIA key placeholder ([7613879](https://github.com/kravchenski/FreeKimiQwenDeepseekApi/commit/761387979db2e720233e1f2b4811c6ce3505ff97))
