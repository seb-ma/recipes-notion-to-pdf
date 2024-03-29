"use strict";

const { Client } = require("@notionhq/client");
const dotenv = require("dotenv");
const fs = require("node:fs");
const path = require("path");
const handlebars = require("handlebars");
const puppeteer = require("puppeteer-core");
const { NotionBlocksHtmlParser } = require("@notion-stuff/blocks-html-parser");

class RecipesNotionHtmlToDoc {

	notionConn = { client: "", dbId: "" };
	semaphoreCount = undefined;
	browserPath = undefined;

	notionBlocksHtmlParser = undefined;
	templateBook = undefined;
	css = undefined;

	async init({semaphoreCount = 3, browserPath = "firefox"}) {
		this.semaphoreCount = semaphoreCount;
		this.browserPath = browserPath;
		// Get Environment variables
		const pathEnv = `${__dirname}/.env`;
		try {
			fs.accessSync(pathEnv);
		} catch (error) {
			throw new Error("You must copy .env.sample to .env and changes values");
		}
		dotenv.config({ path: pathEnv });

		// Initialize Notion API
		this.notionConn = { client: new Client({ auth: process.env.NOTION_KEY }), dbId: process.env.NOTION_DATABASE_ID };
		// Get block to html parser instance
		this.notionBlocksHtmlParser = NotionBlocksHtmlParser.getInstance();
		console.info("Notion API initialized");

		// Get handlebars template
		fs.readFile(`${__dirname}/book.handlebars`, (error, data) => {
			if (error) {
				throw error;
			}
			this.templateBook = handlebars.compile(data.toString());
			// Register helpers
			handlebars.registerHelper("firstLetter", (str) => str.substring(0, 1));
			handlebars.registerHelper("minutesToDuration", (mins) => `${mins < 60 ? "" : Math.trunc(mins / 60) + " h "}${(mins % 60) === 0 ? "" : ((mins < 60 ? "" : "0") + mins % 60).slice(-2) + " min"}`);
			handlebars.registerHelper("hoursToDuration", (hrs) => `${hrs < 1 ? "" : Math.trunc(hrs) + " h "}${hrs - Math.trunc(hrs) === 0 ? "" : ((hrs < 1 ? "" : "0") + Math.trunc((hrs - Math.floor(hrs)) * 60)).slice(-2) + " min"}`);
			handlebars.registerHelper("textToId", (str) => str.normalize("NFKD").replace(/\p{Diacritic}/gu, "").replace(/[^\w]/g, "_"));
			console.info("Template loaded");
		});

		// Get CSS file
		fs.readFile(`${__dirname}/style.css`, (error, data) => {
			if (error) {
				throw error;
			}
			this.css = data.toString();
			console.info("CSS loaded");
		});
	}

	getPropertyValueFromType(property) {
		if (property?.type) {
			if (property.type === "title") {
				return property?.title?.plain_text;
			} else if (property.type === "select") {
				return property.select?.name;
			} else if (property.type === "multi_select") {
				return property?.multi_select.flatMap(opt => { return { name: opt?.name, color: opt?.color }; }).sort((a, b) => a.name.localeCompare(b.name));
			} else if (property.type === "number") {
				return property?.number;
			} else if (property.type === "url") {
				return property?.url;
			}
			console.error(property);
			throw new Error("Type not handled - to be implemented");
		} else {
			return property;
		}
	}

	async getPropertyValue(page, property) {
		const propertyId = page.properties[property].id;
		const propertyItem = await this.notionConn.client.pages.properties.retrieve({
			page_id: page.id,
			property_id: propertyId,
		});

		if (propertyItem.object === "property_item") {
			return this.getPropertyValueFromType(propertyItem);
		}

		// Property is paginated.
		let nextCursor = propertyItem.next_cursor;
		const results = propertyItem.results;

		while (nextCursor !== null) {
			const propertyItem = await this.notionConn.client.pages.properties.retrieve({
				page_id: page.id,
				property_id: propertyId,
				start_cursor: nextCursor,
			});
			nextCursor = propertyItem.next_cursor;
			results.push(...propertyItem.results);
		}
		return results.map(property => this.getPropertyValueFromType(property));
	}

	async getRecipesDB() {
		const pages = [];
		let cursor = undefined;
		do {
			const { results, next_cursor } = await this.notionConn.client.databases.query({
				database_id: this.notionConn.dbId,
				start_cursor: cursor,
			});
			pages.push(...results);
			cursor = next_cursor;
		} while (cursor);
		console.info(`${pages.length} recipes successfully identified.`);
		return await this.parallel(pages, async page => {
			const title = (await this.getPropertyValue(page, process.env.NOTION_DB_NAME)).map(plain_text => plain_text).join("");
			console.log("Get recipe meta for", title);
			return {
				pageId: page.id,
				title: title,
				cover: await page.cover?.external?.url,
				type: await this.getPropertyValue(page, process.env.NOTION_DB_TYPE),
				tags: await this.getPropertyValue(page, process.env.NOTION_DB_TAGS),
				numberPersons: await this.getPropertyValue(page, process.env.NOTION_DB_NB_PERSONS),
				preparationDuration: await this.getPropertyValue(page, process.env.NOTION_DB_PREPA_DURATION),
				cookDuration: await this.getPropertyValue(page, process.env.NOTION_DB_COOK_DURATION),
				restDuration: await this.getPropertyValue(page, process.env.NOTION_DB_REST_DURATION),
				temperature: await this.getPropertyValue(page, process.env.NOTION_DB_TEMPERATURE),
				url: await this.getPropertyValue(page, process.env.NOTION_DB_RECIPE_URL),
			}
		});
	}

	async addContentToRecipes(recipes) {
		return await this.parallel(recipes, async recipe => {
			console.log(`Get recipe content for ${recipe.title}`);
			const response = await this.notionConn.client.blocks.children.list({ block_id: recipe.pageId });
			recipe.htmlContent = this.notionBlocksHtmlParser.parse(response.results);
			return recipe;
		});
	}

	async parallel(items, callbackItem) {
		const result = [];
		if (this.semaphoreCount > 1) {
			// Simple implementation of a semaphore. Drawback: wait the last of a batch before loading a new batch
			while (items.length) {
				result.push(...await Promise.all(items.splice(0, this.semaphoreCount).map(item => callbackItem(item))));
			}
		} else {
			for (let item of items) {
				result.push(await callbackItem(item));
			}
		}

		return result;
	}

	getBook(recipes, file) {
		// Sorting recipes
		recipes.sort((a, b) => a.title.localeCompare(b.title));

		const sections = [
			{ title: process.env.SECTION_STARTER, type: process.env.NOTION_DB_TYPE_STARTER, cover: `${__dirname}/img/starters.svg`, recipes: [] },
			{ title: process.env.SECTION_MAIN, type: process.env.NOTION_DB_TYPE_MAIN, cover: `${__dirname}/img/dishes.svg`, recipes: [] },
			{ title: process.env.SECTION_DESSERT, type: process.env.NOTION_DB_TYPE_DESSERT, cover: `${__dirname}/img/desserts.svg`, recipes: [] },
			{ title: process.env.SECTION_SAUSAGE, type: process.env.NOTION_DB_TYPE_SAUSAGE, cover: `${__dirname}/img/sausages.svg`, recipes: [] },
			{ title: process.env.SECTION_COCKTAIL, type: process.env.NOTION_DB_TYPE_COCKTAIL, cover: `${__dirname}/img/drinks.svg`, recipes: [] },
			{ title: process.env.SECTION_OTHER, type: process.env.NOTION_DB_TYPE_OTHER, cover: `${__dirname}/img/others.svg`, recipes: [] },
		];
		sections.forEach(section => section.recipes = recipes.filter(r => r.type === section.type));

		// Organizing recipes
		const book = {
			title: process.env.BOOK_TITLE,
			cover: `${__dirname}/img/cover.svg`,
			sections: sections,
			// Functions for handlebars template
			cssBook: () => this.css,
		}

		// Rendering book
		const htmlBook = this.templateBook(book);
		if (file) {
			fs.writeFile(file, htmlBook, function (error) {
				if (error) {
					throw (error);
				}
				console.info(`File ${file} created`);
			});
		}
		return htmlBook;
	}

	async printPDF(doc, file) {
		let browser = undefined;
		let page = undefined;
		if (this.browserPath.includes("firefox")) {
			browser = await puppeteer.launch({ headless: true, product: "firefox", executablePath: this.browserPath });
			page = await browser.newPage();
			console.info(`Open ${doc} in browser`);
			try {
				await page.goto(doc, { waitUntil: ["networkidle0", "load", "domcontentloaded"], timeout: 60000 });
			} catch (error) {
				// With Firefox: goto throw timeout with local files: see https://github.com/puppeteer/puppeteer/issues/5504
				// so ignore it and cross fingers to have full loaded page
			}
		} else {
			browser = await puppeteer.launch({ headless: true, executablePath: this.browserPath });
			page = await browser.newPage();
			console.info(`Open ${doc} in browser`);
			await page.goto(doc, { waitUntil: "networkidle0" });
			console.info("Wait full rendering");
			await page.waitForFunction("window.fullRender === true", { timeout: 5 * 60 * 1000 });
		}

		console.info("Generate pdf");
		const pdf = await page.pdf({ format: "A4" });
		await browser.close();
		if (file) {
			fs.writeFile(file, pdf, function (error) {
				if (error) {
					throw (error);
				}
				console.info(`File ${file} created`);
			});
		}
		return pdf;
	}
}

// Run book creation
(async () => {
	const args = process.argv.slice(2);

	try {
		const converter = new RecipesNotionHtmlToDoc()
		await converter.init({semaphoreCount: 6});

		// Retrieve recipes
		let recipes = await converter.getRecipesDB();
		recipes = await converter.addContentToRecipes(recipes);

		// Convert recipes to html then pdf
		const doc = path.resolve(process.cwd(), args[0] ? args[0] : "./recipes");
		await converter.getBook(recipes, `${doc}.html`);
		await converter.printPDF(`file://${doc}.html`, `${doc}.pdf`);
	} catch (error) {
		console.error(error, error);
	}
})();
