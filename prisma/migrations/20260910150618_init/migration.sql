-- CreateEnum
CREATE TYPE "Role" AS ENUM ('user', 'assistant', 'system');

-- CreateTable
CREATE TABLE "Chapter" (
    "number" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "title" TEXT NOT NULL,

    CONSTRAINT "Chapter_pkey" PRIMARY KEY ("number")
);

-- CreateTable
CREATE TABLE "Section" (
    "id" SERIAL NOT NULL,
    "chapterNumber" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,

    CONSTRAINT "Section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Article" (
    "number" INTEGER NOT NULL,
    "chapterNumber" TEXT NOT NULL,
    "sectionId" INTEGER,
    "text" TEXT NOT NULL,
    "notes" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Article_pkey" PRIMARY KEY ("number")
);

-- CreateTable
CREATE TABLE "Annex" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "Annex_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "parts" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolCall" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Citation" (
    "id" SERIAL NOT NULL,
    "messageId" TEXT NOT NULL,
    "articleNumber" INTEGER NOT NULL,

    CONSTRAINT "Citation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "articleNumber" INTEGER,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Chapter_ordinal_key" ON "Chapter"("ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "Section_chapterNumber_number_key" ON "Section"("chapterNumber", "number");

-- CreateIndex
CREATE INDEX "Article_chapterNumber_idx" ON "Article"("chapterNumber");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ToolCall_messageId_idx" ON "ToolCall"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Citation_messageId_articleNumber_key" ON "Citation"("messageId", "articleNumber");

-- CreateIndex
CREATE INDEX "Note_createdAt_idx" ON "Note"("createdAt");

-- AddForeignKey
ALTER TABLE "Section" ADD CONSTRAINT "Section_chapterNumber_fkey" FOREIGN KEY ("chapterNumber") REFERENCES "Chapter"("number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_chapterNumber_fkey" FOREIGN KEY ("chapterNumber") REFERENCES "Chapter"("number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCall" ADD CONSTRAINT "ToolCall_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Citation" ADD CONSTRAINT "Citation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Citation" ADD CONSTRAINT "Citation_articleNumber_fkey" FOREIGN KEY ("articleNumber") REFERENCES "Article"("number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
