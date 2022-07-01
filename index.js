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
	notionBlocksHtmlParser = undefined;
	templateBook = undefined;
	css = undefined;

	constructor() {
		// Get Environment variables
		dotenv.config({ path: `${__dirname}/.env` });

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

	async getRecipesDB() {
		const pages = [];
		let cursor = undefined;

		while (true) {
			const { results, next_cursor } = await this.notionConn.client.databases.query({
				database_id: this.notionConn.dbId,
				start_cursor: cursor,
			});
			pages.push(...results);
			if (!next_cursor) {
				break;
			}
			cursor = next_cursor;
		}
		console.info(`${pages.length} recipes successfully identified.`);
		return pages.map(page => {
			const title = page.properties[process.env.NOTION_DB_NAME].title
				.map(({ plain_text }) => plain_text)
				.join("");
			return {
				pageId: page.id,
				title: title,
				cover: page.cover?.external?.url,
				type: page.properties[process.env.NOTION_DB_TYPE]?.select?.name,
				tags: page.properties[process.env.NOTION_DB_TAGS]?.multi_select.flatMap(opt => { return { name: opt?.name, color: opt?.color }; }).sort((a, b) => a.name.localeCompare(b.name)),
				numberPersons: page.properties[process.env.NOTION_DB_NB_PERSONS]?.number,
				preparationDuration: page.properties[process.env.NOTION_DB_PREPA_DURATION]?.number,
				cookDuration: page.properties[process.env.NOTION_DB_COOK_DURATION]?.number,
				restDuration: page.properties[process.env.NOTION_DB_REST_DURATION]?.number,
				temperature: page.properties[process.env.NOTION_DB_TEMPERATURE]?.number,
				url: page.properties[process.env.NOTION_DB_RECIPE_URL]?.url,
			}
		})
	}

	async addContentToRecipe(recipe) {
		console.log(`Get content for ${recipe.title}`);
		const response = await this.notionConn.client.blocks.children.list({ block_id: recipe.pageId });
		recipe.htmlContent = this.notionBlocksHtmlParser.parse(response.results);
		return recipe;
	}

	async addContentToRecipes(recipes, semaphoreCount = 5) {
		const recipesWithContent = [];
		if (semaphoreCount > 1) {
			while (recipes.length) {
				recipesWithContent.push(...await Promise.all(recipes.splice(0, semaphoreCount).map(recipe => this.addContentToRecipe(recipe))));
			}
		} else {
			for (let recipe of recipes) {
				recipesWithContent.push(await this.addContentToRecipe(recipe));
			}
		}

		return recipesWithContent;
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
			cssBook: () => `<style>${this.css}</style>`,
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
		const browser = await puppeteer.launch({ headless: true, executablePath: "chromium" });
		const page = await browser.newPage();
		console.info(`Open ${doc} in browser`);
		await page.goto(doc, { waitUntil: "networkidle0" });
		console.info("Wait full rendering");
		await page.waitForFunction("window.fullRender === true", { timeout: 5 * 60 * 1000 });

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

	const converter = new RecipesNotionHtmlToDoc();

	// Retrieve recipes
	let recipes = await converter.getRecipesDB();
	recipes = await converter.addContentToRecipes(recipes, 10);

	// Convert recipes to html then pdf
	const doc = path.resolve(process.cwd(), args[0] ? args[0] : "./recipes");
	await converter.getBook(recipes, `${doc}.html`);
	await converter.printPDF(`file://${doc}.html`, `${doc}.pdf`);
})();
