import { PlayerId, PlayerResult, Results, isPaired, isPlayed, isVoluntarilyUnplayedRound } from "./results.js"

export enum UnplayedRoundsAdjustment {
  /**
   * Any unplayed games are counted according to the points that were scored.
   * No "virtual opponents" are created when a player was not paired against
   * a real player.
   */
  NONE = "NONE",

  /**
   * For the most part, the 2023 regulations treat unplayed rounds the same as played rounds,
   * e.g. Buchholz is usually just the sum of the opponent's score. However, opponent's who
   * withdrew from a tournament will have their score adjusted by counting all rounds after the
   * withdrawal as 0.5 points. In addition, the player's own unplayed rounds are counted as a
   * game against an opponent that scored the same number of points at the end of the tournament.
   */
  FIDE_2023 = "FIDE_2023",

  /**
   * Adjustments according to FIDE regulations from 2009. If you had opponents who had
   * unplayed games, those unplayed games are always counted as a draw. If you had
   * unplayed games yourself, your Buchholz is calculated using a 'virtual opponent'.
   * The virtual opponent is assumed to have the same points as you initially and
   * score a draw in all following rounds.
   */
  FIDE_2009 = "FIDE_2009",
}

export type TiebreakConfig = {
  /**
   * How to adjust unplayed games for the calculation of Buchholz, Sonneborn-Berger, and
   * other tiebreaks that are based on opponents' results.
   */
  unplayedRoundsAdjustment: UnplayedRoundsAdjustment
}

/**
 * Modifiers for tiebreaks that are based on a sum of values, such as Buchholz
 * and Sonneborn-Berger. These modifiers are defined in the FIDE Tiebreak Regulations,
 * Article 14.  
 */
export enum Modifier {
  // 14.1 Cut-1: Cut the Least Significant Value
  CUT_1 = 'Cut-1',

  // 14.2 Cut-2: Cut the two Least Significant Values
  CUT_2 = 'Cut-2',
  
  // 14.3 Median­1: Cut the Least and the Most Significant Values (in that order)
  MEDIAN_1 = 'Median1',

  // 14.4 Median­2: Cut the two Least and the two Most Significant Values (in that order)
  MEDIAN_2 = 'Median2'
}

/**
 * Calculates tiebreaks for a tournament with the given results and configuration.
 */
// TODO: Measure performance for large tournaments. Add caching/memoization if needed.
export class TiebreakCalculation {
  constructor(
    private results: Results,
    private config: TiebreakConfig,
  ) {}

  /**
   * Returns the total points the given player scored by the given round.
   */
  public score(player: PlayerId, round: number): number {
    return this.sum(this.results.getAll(player, round).map((result) => {
      return this.scoreForResult(result)
    }))
  }

  // TODO: Maybe turn PlayerResult into a class which returns the score?
  private scoreForResult(result: PlayerResult): number {
    switch (result) {
      case "unpaired":
        return 0
      case "allocated-bye":
        return 1
      case "half-point-bye":
        return 0.5
      default:
        return result.score
    }
  }

  /**
   * Returns the players score with unplayed rounds adjusted according to the configured UnplayedRoundsAdjustment.
   */
  public adjustedScore(player: PlayerId, round: number): number {
    switch (this.config.unplayedRoundsAdjustment) {
      case UnplayedRoundsAdjustment.NONE:
        return this.score(player, round)

      case UnplayedRoundsAdjustment.FIDE_2023: {
        // For the most part, the adjusted score is the same as the normal score, i.e. unplayed rounds are
        // counted according to the points they scored. However, after a player withdrew (i.e. no later rounds
        // where they were available to play), all rounds are counted as 0.5.
        const lastAvailableToPlayRound = this.lastAvailableToPlayRound(player, round)
        return this.score(player, lastAvailableToPlayRound) + (round - lastAvailableToPlayRound) * 0.5
      }

      case UnplayedRoundsAdjustment.FIDE_2009:
        // All unplayed rounds are counted as 0.5 points.
        return this.sum(this.results.getAll(player, round).map((result) => {
          return isPlayed(result) ? result.score : 0.5
        }))
    }
  }

  /**
   * Returns the highest round number in which the player was "available to play", i.e. they didn't
   * voluntarily not play the round. Returns 0 if the player was never available to play. 
   */
  private lastAvailableToPlayRound(player: PlayerId, maxRound: number) {
    for (let round = maxRound; round >= 1; round--) {
      if (!isVoluntarilyUnplayedRound(this.results.get(player, round))) {
        return round
      }
    }
    return 0
  }

  /**
   * Buchholz score. Note that unplayed games are adjusted according to the configured UnplayedRoundsAdjustment.
   */
  public buchholz(player: PlayerId, round: number, modifier?: Modifier): number {
    const opponentScores = this.results.getAll(player, round).map((result, index) => {
      const currentRound = index + 1
      switch (this.config.unplayedRoundsAdjustment) {
        case UnplayedRoundsAdjustment.NONE:
          return isPaired(result) ? this.adjustedScore(result.opponent, round) : 0

        case UnplayedRoundsAdjustment.FIDE_2023:
          if (isPlayed(result)) {
            return this.adjustedScore(result.opponent, round)
          } else {
            // Use a dummy opponent with same score.
            return this.score(player, round)
          }

        case UnplayedRoundsAdjustment.FIDE_2009:
          if (isPlayed(result)) {
            return this.adjustedScore(result.opponent, round)
          } else {
            // Use a virtual opponent.
            const initialScore = this.score(player, currentRound - 1)
            const gameScore = 1 - this.scoreForResult(result)
            const virtualPoints = (round - currentRound) * 0.5
            return initialScore + gameScore + virtualPoints
          }
      }
    })
    return this.sumWithModifier(opponentScores, modifier)
  }

  /**
   * Applies the given modifier to the values (e.g. cutting least signifiant values)
   * and returns the sum of the remaining values. 
   */
  private sumWithModifier(values: number[], modifier?: Modifier): number {
    values.sort()
    switch (modifier) {
      case Modifier.CUT_1:
        values = values.splice(1)
        break
    }
    return this.sum(values)
  }

  private sum(numbers: number[]): number {
    return numbers.reduce((prev, curr) => prev + curr, 0)
  }
}
