-- CreateTable
CREATE TABLE "Rating" (
    "id" SERIAL NOT NULL,
    "messageId" TEXT NOT NULL,
    "articleNumber" INTEGER NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rating_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Rating_articleNumber_idx" ON "Rating"("articleNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Rating_messageId_articleNumber_key" ON "Rating"("messageId", "articleNumber");

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_articleNumber_fkey" FOREIGN KEY ("articleNumber") REFERENCES "Article"("number") ON DELETE RESTRICT ON UPDATE CASCADE;
